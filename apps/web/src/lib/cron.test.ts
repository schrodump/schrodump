// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { nextRun, parseCron, readCron } from "./cron";

// Local-time fixtures: the scheduler and the operator share the wall clock.
const tue = new Date(2026, 8, 8, 9, 40); // Tuesday 8 Sep 2026, 09:40

describe("parseCron", () => {
  it("reads lists, ranges and steps, and refuses what is not five fields", () => {
    expect(parseCron("0 2 * * *")).not.toBeNull();
    expect(parseCron("*/15 9-17 * * 1-5")?.hour.values.size).toBe(9);
    expect(parseCron("0 2 * *")).toBeNull();
    expect(parseCron("60 2 * * *")).toBeNull();
    expect(parseCron("0 2 * * mon")).toBeNull();
  });
});

describe("nextRun", () => {
  it("finds the next daily firing, today when it is still ahead and tomorrow when it passed", () => {
    expect(nextRun("0 10 * * *", tue)).toEqual(new Date(2026, 8, 8, 10, 0));
    expect(nextRun("0 2 * * *", tue)).toEqual(new Date(2026, 8, 9, 2, 0));
  });

  it("finds the next weekly firing on the named day", () => {
    // Sunday 03:00 from a Tuesday is the coming Sunday, the 13th.
    expect(nextRun("0 3 * * 0", tue)).toEqual(new Date(2026, 8, 13, 3, 0));
    expect(nextRun("0 3 * * 7", tue)).toEqual(new Date(2026, 8, 13, 3, 0));
  });

  it("finds the next step firing within the hour", () => {
    expect(nextRun("*/15 * * * *", tue)).toEqual(new Date(2026, 8, 8, 9, 45));
  });

  it("returns null for an expression it cannot read", () => {
    expect(nextRun("not cron", tue)).toBeNull();
  });
});

describe("readCron", () => {
  it("names the shapes an operator writes", () => {
    expect(readCron("0 2 * * *")).toEqual({ kind: "daily", hour: 2, minute: 0 });
    expect(readCron("30 1 * * *")).toEqual({ kind: "daily", hour: 1, minute: 30 });
    expect(readCron("0 * * * *")).toEqual({ kind: "hourly", minute: 0 });
    expect(readCron("*/15 * * * *")).toEqual({ kind: "everyMinutes", every: 15 });
    expect(readCron("0 */6 * * *")).toEqual({ kind: "everyHours", every: 6, minute: 0 });
    expect(readCron("0 3 * * 0")).toEqual({ kind: "weekly", dayOfWeek: 0, hour: 3, minute: 0 });
    expect(readCron("0 4 1 * *")).toEqual({ kind: "monthly", dayOfMonth: 1, hour: 4, minute: 0 });
    expect(readCron("* * * * *")).toEqual({ kind: "everyMinute" });
  });

  it("says nothing for a shape it has no honest sentence for", () => {
    expect(readCron("0 2 * * 1-5")).toBeNull();
    expect(readCron("0 2 1 1 *")).toBeNull();
    expect(readCron("5,35 * * * *")).toBeNull();
  });
});
