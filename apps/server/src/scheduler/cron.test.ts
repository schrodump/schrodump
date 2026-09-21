// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What the scheduler can read. Every expression refused here was measured to throw inside the
// scheduler tick, or to hand back a window the expression does not describe.

import { describe, expect, it } from "vitest";
import { cronProblem, currentWindow, nextWindow } from "./cron.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

describe("cronProblem", () => {
  it("accepts the five-field shapes the interface writes", () => {
    for (const cron of ["0 2 * * *", "*/15 * * * *", "0 3 * * 0", "0 4 1 * *", "0 0 29 2 *", "0 2 * * 7"]) {
      expect(cronProblem(cron, "UTC", NOW)).toBeNull();
    }
  });

  // Measured in production to throw on every tick once stored.
  it.each(["0 0 30 2 *", "0 0 31 4 *", "every day", "0 3 * * 8"])("refuses %j", (cron) => {
    expect(cronProblem(cron, "UTC", NOW)).not.toBeNull();
  });

  // cron-parser takes a leading seconds field; the interface's grammar does not, and a six-field
  // expression can name a new window every second — a new job on every tick.
  it("refuses a seconds field, and says how many fields a schedule has", () => {
    expect(cronProblem("0 0 2 * * *", "UTC", NOW)).toMatch(/five fields.*has 6/);
    expect(cronProblem("*/5 * * * * *", "UTC", NOW)).not.toBeNull();
    expect(cronProblem("@daily", "UTC", NOW)).toMatch(/has 1/);
  });

  // The same impossibility as 30 February, spread across several months: cron-parser parses it and
  // then answers 1962-04-21T23:59:59Z as the most recent window. Nothing throws, which is worse.
  it("refuses a day of month that none of the listed months has", () => {
    expect(cronProblem("0 0 31 2,4 *", "UTC", NOW)).toMatch(/never fire/);
    expect(cronProblem("0 0 31 4,6,9,11 *", "UTC", NOW)).toMatch(/never fire/);
    // One listed month that has the day is enough.
    expect(cronProblem("0 0 30 2,3 *", "UTC", NOW)).toBeNull();
    // A restricted day of week is OR'd with the day of month, so this still fires on Mondays.
    expect(cronProblem("0 0 30 2 1", "UTC", NOW)).toBeNull();
  });
});

describe("windows are read on the instance's clock", () => {
  it("puts 02:00 in São Paulo at 05:00Z, both looking back and looking ahead", () => {
    expect(currentWindow("0 2 * * *", NOW, "America/Sao_Paulo").toISOString()).toBe("2026-09-21T05:00:00.000Z");
    expect(nextWindow("0 2 * * *", NOW, "America/Sao_Paulo").toISOString()).toBe("2026-09-22T05:00:00.000Z");
    expect(nextWindow("0 2 * * *", NOW, "Asia/Tokyo").toISOString()).toBe("2026-09-21T17:00:00.000Z");
  });

  // Without a seed cron-parser picks H at random on every parse — a window that moves on every
  // tick, which the scheduler would turn into a new job on every tick.
  it("reads a hashed field the same way every time", () => {
    const first = currentWindow("H * * * *", NOW, "UTC").getTime();
    for (let i = 0; i < 20; i++) expect(currentWindow("H * * * *", NOW, "UTC").getTime()).toBe(first);
  });
});
