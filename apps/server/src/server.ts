// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createHash } from "node:crypto";
import { buildApp } from "./app.js";
import { rebuildCatalog } from "./jobs/catalog-rebuild.js";
import { createCatalogRebuildPorts } from "./jobs/catalog-rebuild-wiring.js";
import { driverForDestination } from "./jobs/destination-driver.js";
import { drainQueue } from "./jobs/worker.js";
import { startLoop, installShutdown } from "./jobs/loop.js";
import { createWorkerStore, createJobExecutor, sanitizeReason } from "./jobs/worker-wiring.js";
import { pgAdvisoryLock, withAdvisoryLock } from "./scheduler/advisory-lock.js";
import { dispatchDueJobs, recoverOrphanedJobs } from "./scheduler/scheduler.js";
import { cronEvaluator, prismaSchedulerStore } from "./scheduler/wiring.js";
import { betterAuthResolver, createAuth } from "./auth/auth.js";
import { bootstrap } from "./bootstrap/bootstrap.js";
import { createBootstrapDeps, createSetupDeps } from "./bootstrap/wiring.js";
import { assertKekFingerprint, kekBuffer } from "./crypto/kek.js";
import { createAdvisoryLockPrismaClient, createPrismaClient, type PrismaClient } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger, newCorrelationId } from "./observability/pino.js";
import { prismaTargetStore } from "./routes/targets.js";
import { createJobsService, prismaDestinationStore, prismaPolicyStore } from "./routes/wiring.js";

// A stable per-instance auth secret derived from the KEK when none is configured explicitly.
function deriveAuthSecret(kek: Buffer): string {
  return createHash("sha256").update(kek).update("schrodump-better-auth").digest("hex");
}

async function destinationCanary(
  prisma: PrismaClient,
  kek: Buffer,
  organizationId: string,
  destinationId: string,
): Promise<{ ok: boolean; failedOperation: string | null }> {
  const target = await driverForDestination(prisma, kek, organizationId, destinationId);
  if (target === null) return { ok: false, failedOperation: null };
  const health = await target.driver.canary();
  return { ok: health.ok, failedOperation: health.failedOperation };
}

async function runRebuild(
  prisma: PrismaClient,
  kek: Buffer,
  organizationId: string,
  destinationId: string,
): Promise<{ scanned: number; imported: string[]; skipped: string[] }> {
  const target = await driverForDestination(prisma, kek, organizationId, destinationId);
  if (target === null) return { scanned: 0, imported: [], skipped: [] };
  return rebuildCatalog(
    createCatalogRebuildPorts({
      prisma,
      organizationId,
      driver: target.driver,
      prefix: target.prefix,
      destinationId,
    }),
  );
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const kek = kekBuffer(env.SCHRODUMP_KEK);
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = createPrismaClient();

  // Fail the boot if the KEK differs from the one this instance was initialized with.
  await assertKekFingerprint(prisma, kek);

  const auth = createAuth(prisma, {
    secret: env.BETTER_AUTH_SECRET ?? deriveAuthSecret(kek),
    baseURL: env.SCHRODUMP_URL,
  });

  await bootstrap(createBootstrapDeps(prisma, auth, env, logger), env);

  const app = buildApp({
    logger,
    auth,
    resolver: betterAuthResolver(auth, prisma),
    setupDeps: createSetupDeps(prisma, auth),
    targetStore: (organizationId) => prismaTargetStore(prisma, organizationId),
    destinationStore: (organizationId) => prismaDestinationStore(prisma, organizationId),
    destinationCanary: (organizationId, destinationId) =>
      destinationCanary(prisma, kek, organizationId, destinationId),
    policyStore: (organizationId) => prismaPolicyStore(prisma, organizationId),
    jobsService: createJobsService(prisma, kek),
    catalogRebuild: (organizationId, destinationId) =>
      runRebuild(prisma, kek, organizationId, destinationId),
    kek,
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  // --- worker boot ---
  const WORKER_LOCK_KEY = 0x5343_4852_444d_5031n; // "SCHRDMP1"
  // The advisory lock must hold on ONE pinned connection for the whole drain; the shared client
  // pools freely, so it gets its own single-connection client (never used for API/drain queries).
  const advisoryLockPrisma = createAdvisoryLockPrismaClient(env.DATABASE_URL);
  const lock = pgAdvisoryLock(advisoryLockPrisma);

  // 1. Orphan recovery: a RUNNING job at boot belongs to a process that died. Gated under the same
  //    advisory lock as the drain loop below: BackupJob has no owner/lease column, so a replica
  //    booting mid rolling-restart could otherwise mark another LIVE replica's RUNNING job FAILED.
  //    null means another holder has the lock — a live replica, so recovery is correctly skipped.
  const schedulerStore = prismaSchedulerStore(prisma);
  const recovered = await withAdvisoryLock(lock, WORKER_LOCK_KEY, () => recoverOrphanedJobs(schedulerStore));
  if (recovered !== null && recovered > 0) logger.info({ count: recovered }, "recovered orphaned jobs");

  // Process-wide cancellation for the worker. Tripped by SIGTERM below; every container the
  // executor starts carries this signal, so aborting it kills them and releases their scratch.
  const shutdownController = new AbortController();

  // 2. Single-flight worker (same advisory lock keeps one replica draining).
  const store = createWorkerStore(prisma);
  const executor = createJobExecutor({ prisma, kek, env });
  const workerDeps = {
    store,
    executor,
    log: logger,
    sanitizeReason,
    signal: shutdownController.signal,
  };
  const handle = startLoop({
    intervalMs: env.WORKER_POLL_MS,
    // A drain-level throw (claim query fails, tryLock throws) must be logged, not swallowed, or a
    // wedged worker goes silent. Per-job crashes are already handled inside drainQueue.
    tick: () =>
      withAdvisoryLock(lock, WORKER_LOCK_KEY, () => drainQueue(workerDeps))
        .then((n) => n ?? 0)
        .catch((err) => {
          logger.error({ err }, "worker drain tick failed");
          return 0;
        }),
  });

  // 3. Scheduler: evaluate enabled policies and dispatch due backup jobs on a tick. Its OWN
  //    advisory-lock key (not the worker's), so scheduling and draining run independently, each
  //    single-flight across replicas. currentWindow looks back, so a window missed while the
  //    process was down is still created on the next tick — idempotent by (policyId, scheduledAt).
  const SCHEDULER_LOCK_KEY = 0x5343_4852_444d_5032n; // "SCHRDMP2"
  const schedulerDeps = { store: schedulerStore, cron: cronEvaluator(), now: () => new Date(), newCorrelationId };
  const schedulerHandle = startLoop({
    intervalMs: env.SCHRODUMP_SCHEDULER_TICK_MS,
    tick: () =>
      withAdvisoryLock(lock, SCHEDULER_LOCK_KEY, () => dispatchDueJobs(schedulerDeps)).catch((err) => {
        logger.error({ err }, "scheduler dispatch tick failed");
      }),
  });

  // 4. Graceful shutdown: abort the in-flight job and clean up, rather than wait for it. A logical
  //    dump takes minutes to hours and `docker stop` gives ~10s, so draining is not on the table.
  //    An unfinished backup is a FAILED job and an UNOBSERVED artifact — consistent with the thesis
  //    — and, crucially, no cleartext dump survives the shutdown. The abort rides paths that already
  //    exist: the runner kills the container and the executor's finally releases the scratch
  //    reservation, while the job's own catch is what records the terminal state — BACKUP through
  //    backup.ts, RESTORE through restore.ts, VERIFY through verify.ts's INCONCLUSIVE branch (a
  //    shutdown observed nothing, so it must never condemn the artifact). runWorkerOnce's catch is
  //    only the backstop for a throw that escapes all three. Boot-time orphan recovery and the
  //    scratch sweep remain the backstop for a SIGKILL that beats the grace.
  installShutdown({
    onSignal: async () => {
      handle.stop();
      schedulerHandle.stop();
      shutdownController.abort();
      const graceMs = env.SCHRODUMP_SHUTDOWN_GRACE_MS;
      // ONE deadline over the WHOLE sequence, drain AND disconnect. Bounding only the drain leaves
      // the shutdown unbounded: $disconnect can block too (a metadata-DB connection that never
      // answers), and an unbounded step after a bounded one is still an unbounded shutdown. The
      // timer is unref'd so this ceiling can never itself be what holds the process open.
      const deadline = new Promise<"expired">((resolve) =>
        setTimeout(() => resolve("expired"), graceMs).unref(),
      );
      let drained = false;
      const sequence = handle
        .whenIdle()
        .then(() => {
          drained = true;
          return advisoryLockPrisma.$disconnect();
        })
        .then(() => "settled" as const);
      if ((await Promise.race([sequence, deadline])) === "expired") {
        // Wedged (most likely a hung Docker daemon call, or a stuck connection). Exit anyway —
        // holding the process past the docker-stop window only trades this for a SIGKILL, and the
        // boot sweep recovers either way. `drained` says which half ran out of budget.
        logger.warn({ graceMs, drained }, "shutdown grace expired");
      }
    },
  });
}
