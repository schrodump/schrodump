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

  // 2. Single-flight worker (same advisory lock keeps one replica draining).
  const store = createWorkerStore(prisma);
  const executor = createJobExecutor({ prisma, kek, env });
  const workerDeps = { store, executor, log: logger, sanitizeReason };
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

  // 4. Graceful shutdown: stop both loops before exit (scratch of an in-flight job is released by
  //    the ScratchManager the executor holds; full mid-dump cancel is the runner's timeout path).
  //    Also drop the dedicated advisory-lock connection so its session lock is released promptly.
  installShutdown({
    onSignal: async () => {
      handle.stop();
      schedulerHandle.stop();
      await advisoryLockPrisma.$disconnect();
    },
  });
}
