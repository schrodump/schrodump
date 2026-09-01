// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createHash } from "node:crypto";
import { setMaxListeners } from "node:events";
import { buildApp } from "./app.js";
import { rebuildCatalog } from "./jobs/catalog-rebuild.js";
import { createCatalogRebuildPorts } from "./jobs/catalog-rebuild-wiring.js";
import { driverForDestination } from "./jobs/destination-driver.js";
import { drainQueue } from "./jobs/worker.js";
import { startLoop, installShutdown } from "./jobs/loop.js";
import { runScheduledSelfBackup } from "./jobs/self-backup-scheduler.js";
import { runGracefulShutdown } from "./jobs/shutdown.js";
import { defaultSmtpDeps } from "./notifications/smtp.js";
import { runNotifications } from "./notifications/wiring.js";
import { createWorkerStore, createJobExecutor, sanitizeReason } from "./jobs/worker-wiring.js";
import { pgAdvisoryLock, withAdvisoryLock } from "./scheduler/advisory-lock.js";
import { dispatchDueJobs, recoverOrphanedJobs } from "./scheduler/scheduler.js";
import { cronEvaluator, prismaSchedulerStore } from "./scheduler/wiring.js";
import { betterAuthResolver, createAuth, parseTrustedProxies } from "./auth/auth.js";
import { bootstrap } from "./bootstrap/bootstrap.js";
import { createBootstrapDeps, createSetupDeps } from "./bootstrap/wiring.js";
import { assertKekFingerprint, kekBuffer } from "./crypto/kek.js";
import { createAdvisoryLockPrismaClient, createPrismaClient, type PrismaClient } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger, newCorrelationId } from "./observability/pino.js";
import { prismaTargetStore } from "./routes/targets.js";
import {
  createJobsService,
  prismaDestinationStore,
  prismaNotificationChannelStore,
  prismaPolicyStore,
} from "./routes/wiring.js";

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

  const trustedProxies = parseTrustedProxies(env.SCHRODUMP_TRUSTED_PROXIES);
  if (trustedProxies.length === 0) {
    logger.warn(
      "SCHRODUMP_TRUSTED_PROXIES is unset: the login rate limit will bucket on X-Forwarded-For as " +
        "received. If a reverse proxy sits in front of this server, set it to that proxy's CIDR " +
        "(plus 127.0.0.1/32) — otherwise the limit is either bypassable or shared by every client",
    );
  }
  const auth = createAuth(prisma, {
    secret: env.BETTER_AUTH_SECRET ?? deriveAuthSecret(kek),
    baseURL: env.SCHRODUMP_URL,
    trustedProxies,
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
    notificationChannelStore: (organizationId) =>
      prismaNotificationChannelStore(prisma, organizationId),
    jobsService: createJobsService(prisma, kek),
    catalogRebuild: (organizationId, destinationId) =>
      runRebuild(prisma, kek, organizationId, destinationId),
    prisma,
    selfBackupDestinationId: env.SCHRODUMP_SELF_BACKUP_DESTINATION_ID ?? null,
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
  const recovered = await withAdvisoryLock(lock, WORKER_LOCK_KEY, () =>
    recoverOrphanedJobs(schedulerStore),
  );
  if (recovered !== null && recovered > 0)
    logger.info({ count: recovered }, "recovered orphaned jobs");

  // 2. Single-flight worker (same advisory lock keeps one replica draining).
  const shutdownController = new AbortController();
  // Every in-flight run adds its own "abort" listener to this shared signal; under concurrency
  // (staged parallelism, or backup+verify overlapping) that can exceed Node's default cap of 10 and
  // print a spurious MaxListenersExceededWarning. This is one process-wide controller, not a leak.
  setMaxListeners(0, shutdownController.signal);
  const store = createWorkerStore(prisma, shutdownController.signal);
  const executor = createJobExecutor({ prisma, kek, env, signal: shutdownController.signal });
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
  const schedulerDeps = {
    store: schedulerStore,
    cron: cronEvaluator(),
    now: () => new Date(),
    newCorrelationId,
  };
  const schedulerHandle = startLoop({
    intervalMs: env.SCHRODUMP_SCHEDULER_TICK_MS,
    tick: () =>
      withAdvisoryLock(lock, SCHEDULER_LOCK_KEY, async () => {
        await dispatchDueJobs(schedulerDeps);
        // Same tick, same single-flight lock: notifications read committed state after the fact and
        // are not in any job's path, so a failure here can never fail a backup. Caught separately
        // so a broken notifier cannot stop the scheduler from dispatching.
        await runNotifications({
          prisma,
          kek,
          now: () => new Date(),
          fetch,
          smtp: defaultSmtpDeps,
          log: logger,
          minEvaluationGapMs: env.SCHRODUMP_NOTIFY_MIN_GAP_MS,
        }).catch((err) => {
          logger.error({ err }, "notification pass failed");
        });
      }).catch((err) => {
        logger.error({ err }, "scheduler dispatch tick failed");
      }),
  });

  // 4. Self-backup: dumps THIS deployment's metadata database on its own cadence.
  //
  //    Its own loop and its own advisory-lock key, not a step inside the scheduler tick: a metadata
  //    dump takes minutes on a busy install, and startLoop is single-flight, so folding it into the
  //    scheduler would stop dispatching backups for the length of every self-backup.
  //
  //    Unconfigured is a WARNING, not silence. A deployment whose metadata database is not backed
  //    up still restores every artifact in the bucket — the manifests make that possible — but it
  //    does so by rebuilding the catalog, which is a much longer day than restoring one dump.
  const SELF_BACKUP_LOCK_KEY = 0x5343_4852_444d_5033n; // "SCHRDMP3"
  let selfBackupHandle: { stop(): void; whenIdle(): Promise<void> } | null = null;
  const selfBackupDestinationId = env.SCHRODUMP_SELF_BACKUP_DESTINATION_ID;
  if (selfBackupDestinationId === undefined) {
    logger.warn(
      "self-backup is not configured (SCHRODUMP_SELF_BACKUP_DESTINATION_ID is unset): this " +
        "deployment's metadata database is not being backed up",
    );
  } else {
    selfBackupHandle = startLoop({
      intervalMs: env.SCHRODUMP_SCHEDULER_TICK_MS,
      tick: () =>
        withAdvisoryLock(lock, SELF_BACKUP_LOCK_KEY, () =>
          runScheduledSelfBackup({
            prisma,
            kek,
            databaseUrl: env.DATABASE_URL,
            destinationId: selfBackupDestinationId,
            network: env.SCHRODUMP_SELF_BACKUP_NETWORK,
            intervalMs: env.SCHRODUMP_SELF_BACKUP_INTERVAL_MS,
            now: () => new Date(),
            log: logger,
            signal: shutdownController.signal,
          }),
        ).catch((err) => {
          logger.error({ err }, "self-backup tick failed");
        }),
    });
  }

  // 4. Graceful shutdown: stop both loops, abort the in-flight run, await the drain under a grace
  //    budget, then drop the dedicated advisory-lock connection so its session lock is released
  //    promptly. See runGracefulShutdown for the ordering rationale.
  installShutdown({
    onSignal: () =>
      runGracefulShutdown({
        handle,
        scheduler: schedulerHandle,
        ...(selfBackupHandle !== null ? { selfBackup: selfBackupHandle } : {}),
        controller: shutdownController,
        disconnect: () => advisoryLockPrisma.$disconnect(),
        graceMs: env.SCHRODUMP_SHUTDOWN_GRACE_MS,
        log: logger,
      }),
  });
}
