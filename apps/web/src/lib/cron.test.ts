// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { nextRun, parseCron, readCron, sameWallClock } from "./cron";

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

  // SC-02. Ranges alone let "0 0 30 2 *" through, the server stored it, and cron-parser then threw
  // inside every scheduler tick. An expression that can never fire is unreadable here too, so the
  // form blocks Save on the path it already has.
  it("refuses a day of month that no listed month has", () => {
    expect(parseCron("0 0 30 2 *")).toBeNull();
    expect(parseCron("0 0 31 2 *")).toBeNull();
    for (const month of [4, 6, 9, 11]) expect(parseCron(`0 0 31 ${month} *`)).toBeNull();
    expect(parseCron("0 0 31 4,6,9,11 *")).toBeNull();
    expect(readCron("0 0 30 2 *")).toBeNull();
    expect(nextRun("0 0 30 2 *", tue, "UTC")).toBeNull();
  });

  it("keeps what does fire, however rarely", () => {
    // Leap years.
    expect(parseCron("0 0 29 2 *")).not.toBeNull();
    // One of the listed months has a 30th.
    expect(parseCron("0 0 30 2,3 *")).not.toBeNull();
    // A restricted day of week is OR'd with the day of month: this fires on Mondays in February.
    expect(parseCron("0 0 30 2 1")).not.toBeNull();
    expect(parseCron("0 0 31 * *")).not.toBeNull();
  });
});

// SC-01. The scheduler reads every cron on the instance's clock, and the preview has to read it on
// the same one: it used to walk the browser's, so a São Paulo operator was promised 02:00 for a job
// that ran at 23:00 their time. Instants in, instants out, so none of this depends on the clock of
// the machine running the test.
describe("nextRun on the instance's clock", () => {
  const noonUtc = new Date("2026-09-21T12:00:00.000Z");

  it("finds 02:00 in the zone it is given, whatever zone the browser is in", () => {
    expect(nextRun("0 2 * * *", noonUtc, "America/Sao_Paulo")?.toISOString()).toBe("2026-09-22T05:00:00.000Z");
    expect(nextRun("0 2 * * *", noonUtc, "Asia/Tokyo")?.toISOString()).toBe("2026-09-21T17:00:00.000Z");
    expect(nextRun("0 2 * * *", noonUtc, "UTC")?.toISOString()).toBe("2026-09-22T02:00:00.000Z");
  });

  it("reads the day and the weekday on the zone's calendar, not the browser's", () => {
    // 12:00Z on Monday the 21st is already 21:00 Monday in Tokyo; Tuesday 03:00 there is 18:00Z.
    expect(nextRun("0 3 * * 2", noonUtc, "Asia/Tokyo")?.toISOString()).toBe("2026-09-21T18:00:00.000Z");
    expect(nextRun("0 4 1 * *", noonUtc, "America/Sao_Paulo")?.toISOString()).toBe("2026-10-01T07:00:00.000Z");
  });

  // The hour New York's clocks spring forward over has no 02:30; cron-parser lands past the jump,
  // at 03:30 EDT, and so does the preview.
  it("lands past a wall time the zone skips, where the scheduler does", () => {
    expect(nextRun("30 2 * * *", new Date("2026-03-08T06:00:00.000Z"), "America/New_York")?.toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("finds a 29 February years ahead", () => {
    expect(nextRun("0 0 29 2 *", noonUtc, "UTC")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("tells whether an instant reads the same on the instance's clock as on the viewer's", () => {
    const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(sameWallClock(noonUtc, viewer)).toBe(true);
    const other = new Date(noonUtc).getTimezoneOffset() === 0 ? "America/Sao_Paulo" : "UTC";
    expect(sameWallClock(noonUtc, other)).toBe(false);
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
