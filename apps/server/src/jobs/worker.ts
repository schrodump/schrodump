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
}

export type { VerifyLevel };

export interface BackupResult {
  ok: boolean;
  artifactId: string | null;
  verifyLevel: VerifyLevel;
}

export interface JobExecutor {
  // Runs the backup pipeline (which sets the job's terminal state via its own ports) and reports
  // the outcome the worker needs to decide chaining.
  runBackup(job: ClaimedJob): Promise<BackupResult>;
  // Runs verify (which sets the job AND artifact terminal state via its own ports).
  runVerify(job: ClaimedJob): Promise<void>;
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
}

export async function runWorkerOnce(deps: WorkerDeps): Promise<"ran" | "idle"> {
  const job = await deps.store.claimNextJob();
  if (job === null) return "idle";

  try {
    if (job.kind === "BACKUP") {
      const result = await deps.executor.runBackup(job);
      if (result.ok && result.artifactId !== null && result.verifyLevel !== "NONE") {
        await deps.store.enqueueVerify(job.organizationId, result.artifactId);
        deps.log.info({ jobId: job.id, artifactId: result.artifactId }, "backup ok — verify enqueued");
      }
    } else if (job.kind === "VERIFY") {
      await deps.executor.runVerify(job);
    } else {
      await deps.store.failJob(job.id, `unsupported job kind: ${job.kind}`);
    }
  } catch (err) {
    const reason = deps.sanitizeReason(err);
    deps.log.error({ jobId: job.id, reason }, "job crashed — marking FAILED");
    await deps.store.failJob(job.id, reason);
  }
  return "ran";
}

export async function drainQueue(deps: WorkerDeps): Promise<number> {
  let count = 0;
  while ((await runWorkerOnce(deps)) === "ran") count += 1;
  return count;
}
