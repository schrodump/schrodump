// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The worker brain: claim one job, dispatch by kind, chain backup -> verify. Deliberately free of
// I/O so it is unit-tested with fakes; the real store/executor are assembled in worker-wiring.ts.

import type { VerifyLevel } from "./verify.js";

export interface ClaimedJob {
  id: string;
  organizationId: string;
  kind: "BACKUP" | "VERIFY" | "RESTORE";
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
}

export interface JobExecutor {
  // Each method takes the process-wide shutdown signal so it can cancel the containers it starts.
  // Optional: a caller with no shutdown story (tests, integration harnesses) omits it.
  //
  // Runs the backup pipeline (which sets the job's terminal state via its own ports) and reports
  // the outcome the worker needs to decide chaining.
  runBackup(job: ClaimedJob, signal?: AbortSignal): Promise<BackupResult>;
  // Runs verify (which sets the job AND artifact terminal state via its own ports).
  runVerify(job: ClaimedJob, signal?: AbortSignal): Promise<void>;
  // Runs restore (which sets the RESTORE job's terminal state via its own ports).
  runRestore(job: ClaimedJob, signal?: AbortSignal): Promise<void>;
}

export interface WorkerStore {
  claimNextJob(): Promise<ClaimedJob | null>;
  failJob(jobId: string, reason: string): Promise<void>;
  enqueueVerify(organizationId: string, artifactId: string): Promise<string>;
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
  // Tripped by the SIGTERM handler. It both cancels the in-flight job's containers and stops this
  // worker from claiming another one — see the guard at the top of runWorkerOnce.
  signal?: AbortSignal;
}

export async function runWorkerOnce(deps: WorkerDeps): Promise<"ran" | "idle"> {
  // Shutting down: do not claim work this process cannot finish. Claiming here would start a fresh
  // dump inside the docker-stop budget and leak exactly the cleartext scratch the shutdown exists
  // to remove. Reporting "idle" is also what ends drainQueue's loop.
  if (deps.signal?.aborted === true) return "idle";

  const job = await deps.store.claimNextJob();
  if (job === null) return "idle";

  // Each job kind records its OWN terminal state: BACKUP through backup.ts's catch, RESTORE through
  // restore.ts's, VERIFY through verify.ts (an INCONCLUSIVE proof fails the job and leaves the
  // artifact untouched). This catch is the backstop for a throw that escapes all three — the job
  // never reached a terminal state, so failJob is correct — not the normal failure path.
  let backup: BackupResult | null = null;
  try {
    if (job.kind === "BACKUP") {
      backup = await deps.executor.runBackup(job, deps.signal);
    } else if (job.kind === "VERIFY") {
      await deps.executor.runVerify(job, deps.signal);
    } else if (job.kind === "RESTORE") {
      await deps.executor.runRestore(job, deps.signal);
    } else {
      await deps.store.failJob(job.id, `unsupported job kind: ${job.kind}`);
    }
  } catch (err) {
    const reason = deps.sanitizeReason(err);
    deps.log.error({ jobId: job.id, reason }, "job crashed — marking FAILED");
    await deps.store.failJob(job.id, reason);
    return "ran";
  }

  // Chaining runs AFTER the job is already terminal (SUCCEEDED). A failure to enqueue the follow-up
  // verify must NOT retroactively FAIL a backup that actually succeeded — it is only logged.
  if (backup !== null && backup.ok && backup.artifactId !== null && backup.verifyLevel !== "NONE") {
    try {
      await deps.store.enqueueVerify(job.organizationId, backup.artifactId);
      deps.log.info({ jobId: job.id, artifactId: backup.artifactId }, "backup ok — verify enqueued");
    } catch (err) {
      const reason = deps.sanitizeReason(err);
      deps.log.error({ jobId: job.id, reason }, "backup ok but verify enqueue failed");
    }
  }
  return "ran";
}

export async function drainQueue(deps: WorkerDeps): Promise<number> {
  let count = 0;
  while ((await runWorkerOnce(deps)) === "ran") count += 1;
  return count;
}
