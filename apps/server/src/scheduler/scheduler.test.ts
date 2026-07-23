// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  dispatchDueJobs,
  recoverOrphanedJobs,
  type CronEvaluator,
  type ScheduledPolicy,
  type SchedulerDeps,
  type SchedulerStore,
} from "./scheduler.js";

const WINDOW = new Date("2026-07-23T00:00:00Z");
const fixedCron: CronEvaluator = { currentWindow: () => WINDOW };

class FakeStore implements SchedulerStore {
  policies: ScheduledPolicy[] = [{ id: "p1", organizationId: "o1", cron: "0 0 * * *" }];
  readonly seen = new Set<string>();
  createdCount = 0;
  running = 3;

  enabledPolicies(): Promise<ScheduledPolicy[]> {
    return Promise.resolve(this.policies);
  }

  createScheduledJob(input: {
    organizationId: string;
    policyId: string;
    scheduledAt: Date;
    correlationId: string;
  }): Promise<string | null> {
    const key = `${input.policyId}|${input.scheduledAt.toISOString()}`;
    if (this.seen.has(key)) return Promise.resolve(null);
    this.seen.add(key);
    this.createdCount += 1;
    return Promise.resolve(`job-${this.createdCount}`);
  }

  failRunningJobs(): Promise<number> {
    const count = this.running;
    this.running = 0;
    return Promise.resolve(count);
  }
}

function makeDeps(store: SchedulerStore): SchedulerDeps {
  return {
    store,
    cron: fixedCron,
    now: () => new Date("2026-07-23T00:05:00Z"),
    newCorrelationId: () => "corr",
  };
}

describe("dispatchDueJobs", () => {
  it("dispatches one job per due policy", async () => {
    const created = await dispatchDueJobs(makeDeps(new FakeStore()));
    expect(created).toHaveLength(1);
  });

  it("creates only one job for a window even when the tick fires twice (idempotency)", async () => {
    const store = new FakeStore();
    await dispatchDueJobs(makeDeps(store));
    await dispatchDueJobs(makeDeps(store)); // same window again
    expect(store.createdCount).toBe(1);
  });
});

describe("recoverOrphanedJobs", () => {
  it("marks every RUNNING job FAILED at boot", async () => {
    expect(await recoverOrphanedJobs(new FakeStore())).toBe(3);
  });
});
