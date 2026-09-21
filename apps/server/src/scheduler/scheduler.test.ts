// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { cronEvaluator } from "./wiring.js";
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

function makeDeps(store: SchedulerStore, over: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    store,
    cron: fixedCron,
    now: () => new Date("2026-07-23T00:05:00Z"),
    newCorrelationId: () => "corr",
    log: { error: () => undefined },
    ...over,
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

  // SC-02, reproduced on a live deployment: POST /policies accepted "0 0 30 2 *", and from the next
  // tick cron-parser threw out of this loop — every policy listed after it, in every organization,
  // stopped being dispatched. The real evaluator, so the throw is the one production saw.
  it("dispatches every other policy past one whose cron cannot be read, and says which it skipped", async () => {
    const store = new FakeStore();
    store.policies = [
      { id: "before", organizationId: "o1", cron: "0 0 * * *" },
      { id: "feb-30", organizationId: "o2", cron: "0 0 30 2 *" },
      { id: "after", organizationId: "o3", cron: "0 0 * * *" },
    ];
    const logged: Array<{ o: Record<string, unknown>; m: string }> = [];
    const created = await dispatchDueJobs(
      makeDeps(store, {
        cron: cronEvaluator("UTC"),
        log: { error: (o, m) => logged.push({ o, m }) },
      }),
    );

    expect(created).toHaveLength(2);
    expect([...store.seen].map((key) => key.split("|")[0])).toEqual(["before", "after"]);
    // Once, for the one it skipped, naming it and what the parser said.
    expect(logged).toHaveLength(1);
    expect(logged[0]?.o).toMatchObject({ policyId: "feb-30", reason: expect.stringMatching(/day of month/i) });
  });
});

describe("recoverOrphanedJobs", () => {
  it("marks every RUNNING job FAILED at boot", async () => {
    expect(await recoverOrphanedJobs(new FakeStore())).toBe(3);
  });
});
