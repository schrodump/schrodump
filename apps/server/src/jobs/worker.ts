// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The worker brain: claim one job, dispatch by kind, chain backup -> verify + retention.
// Deliberately free of I/O so it is unit-tested with fakes; the real store/executor are assembled
// in worker-wiring.ts.

import type { VerifyLevel } from "./verify.js";

export interface ClaimedJob {
  id: string;
  organizationId: string;
  kind: "BACKUP" | "VERIFY" | "RESTORE" | "RETENTION";
  policyId: string | null;
  artifactId: string | null;
  correlationId: string;
  // RESTORE-only: { target, confirmExistingDatabase, triggeredByUserId }. Null for BACKUP/VERIFY.
  // Validated by restoreParamsOf before use.
  restoreParams: unknown;
}

export type { VerifyLevel };

export interface BackupResult {
  ok: boolean;
  artifactId: string | null;
  verifyLevel: VerifyLevel;
  // Whether the originating policy asks to retain anything at all (any keep* counter > 0). Read
  // from the policy by the executor, for the same reason verifyLevel is: the worker decides
  // chaining and must not query. False means no RETENTION job is created — a policy that keeps
  // everything forever should not accumulate a job per backup saying it did nothing.
  retentionConfigured: boolean;
}

export interface JobExecutor {
  // Runs the backup pipeline (which sets the job's terminal state via its own ports) and reports
  // the outcome the worker needs to decide chaining.
  runBackup(job: ClaimedJob): Promise<BackupResult>;
  // Runs verify (which sets the job AND artifact terminal state via its own ports).
  runVerify(job: ClaimedJob): Promise<void>;
  // Runs restore (which sets the RESTORE job's terminal state via its own ports).
  runRestore(job: ClaimedJob): Promise<void>;
  // Runs the policy's retention cycle (which sets the RETENTION job's terminal state via its own
  // ports). Deleting a backup is an outcome an operator must be able to read afterwards, which is
  // why it is a job with a row and a state, not a side effect of some loop.
  runRetention(job: ClaimedJob): Promise<void>;
}

export interface WorkerStore {
  claimNextJob(): Promise<ClaimedJob | null>;
  failJob(jobId: string, reason: string): Promise<void>;
  enqueueVerify(organizationId: string, artifactId: string): Promise<string>;
  enqueueRetention(organizationId: string, policyId: string): Promise<string>;
}

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WorkerDeps {
  store: WorkerStore;
  executor: JobExecutor;
  log: WorkerLogger;
  // Turns an arbitrary thrown value into a log/DB-safe reason (never a raw driver message).
  sanitizeReason(err: unknown): string;
}

export async function runWorkerOnce(deps: WorkerDeps): Promise<"ran" | "idle"> {
  const job = await deps.store.claimNextJob();
  if (job === null) return "idle";

  // Only the executor's own run may fail the job. A crash here means the job never reached a
  // terminal state, so failJob is correct.
  let backup: BackupResult | null = null;
  try {
    if (job.kind === "BACKUP") {
      backup = await deps.executor.runBackup(job);
    } else if (job.kind === "VERIFY") {
      await deps.executor.runVerify(job);
    } else if (job.kind === "RESTORE") {
      await deps.executor.runRestore(job);
    } else if (job.kind === "RETENTION") {
      await deps.executor.runRetention(job);
    } else {
      await deps.store.failJob(job.id, `unsupported job kind: ${job.kind}`);
    }
  } catch (err) {
    const reason = deps.sanitizeReason(err);
    deps.log.error({ jobId: job.id, reason }, "job crashed — marking FAILED");
    await deps.store.failJob(job.id, reason);
    return "ran";
  }

  // Chaining runs AFTER the job is already terminal (SUCCEEDED). A failure to enqueue a follow-up
  // must NOT retroactively FAIL a backup that actually succeeded — it is only logged.
  if (backup !== null && backup.ok && backup.artifactId !== null && backup.verifyLevel !== "NONE") {
    try {
      await deps.store.enqueueVerify(job.organizationId, backup.artifactId);
      deps.log.info({ jobId: job.id, artifactId: backup.artifactId }, "backup ok — verify enqueued");
    } catch (err) {
      const reason = deps.sanitizeReason(err);
      deps.log.error({ jobId: job.id, reason }, "backup ok but verify enqueue failed");
    }
  }

  // Retention is chained to backup SUCCESS on purpose, and that choice is the safety property:
  // the set of artifacts only grows when a backup lands, so that is the only moment pruning can be
  // needed — and a backup that FAILED must never cost you an older copy. A policy that stops
  // backing up stops deleting. `policyId` is null for a manual or self-backup, which has no
  // retention policy to apply.
  if (backup !== null && backup.ok && backup.retentionConfigured && job.policyId !== null) {
    try {
      await deps.store.enqueueRetention(job.organizationId, job.policyId);
      deps.log.info({ jobId: job.id, policyId: job.policyId }, "backup ok — retention enqueued");
    } catch (err) {
      const reason = deps.sanitizeReason(err);
      deps.log.error({ jobId: job.id, reason }, "backup ok but retention enqueue failed");
    }
  }
  return "ran";
}

export async function drainQueue(deps: WorkerDeps): Promise<number> {
  let count = 0;
  while ((await runWorkerOnce(deps)) === "ran") count += 1;
  return count;
}
