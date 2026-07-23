// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export interface ScheduledPolicy {
  id: string;
  organizationId: string;
  cron: string;
}

export interface CronEvaluator {
  // The most recent window that has fired at or before `now` for this cron expression. The
  // idempotency key on the job dedupes repeated ticks landing on the same window.
  currentWindow(cron: string, now: Date): Date;
}

export interface SchedulerStore {
  enabledPolicies(): Promise<ScheduledPolicy[]>;
  // Idempotently creates a scheduled BACKUP job keyed on (policyId, scheduledAt). Returns the new
  // jobId, or null when that window already has a job.
  createScheduledJob(input: {
    organizationId: string;
    policyId: string;
    scheduledAt: Date;
    correlationId: string;
  }): Promise<string | null>;
  // Marks every RUNNING job FAILED with a reason (boot orphan recovery). Returns the count.
  failRunningJobs(reason: string): Promise<number>;
}

export interface SchedulerDeps {
  store: SchedulerStore;
  cron: CronEvaluator;
  now(): Date;
  newCorrelationId(): string;
}

// Evaluates each enabled policy and idempotently dispatches a job for its current window. Because
// creation is keyed on (policyId, scheduledAt), a duplicate tick (or a second replica) never
// creates a second job. Returns the jobIds actually created this tick.
export async function dispatchDueJobs(deps: SchedulerDeps): Promise<string[]> {
  const now = deps.now();
  const created: string[] = [];
  for (const policy of await deps.store.enabledPolicies()) {
    const scheduledAt = deps.cron.currentWindow(policy.cron, now);
    const jobId = await deps.store.createScheduledJob({
      organizationId: policy.organizationId,
      policyId: policy.id,
      scheduledAt,
      correlationId: deps.newCorrelationId(),
    });
    if (jobId !== null) created.push(jobId);
  }
  return created;
}

// A RUNNING job at boot belongs to a process that died — the runner removes its containers, so
// there is nothing to re-adopt. Mark such jobs FAILED explicitly rather than leaving them hung
// indefinitely.
export async function recoverOrphanedJobs(store: SchedulerStore): Promise<number> {
  return store.failRunningJobs("orphaned by process restart");
}
