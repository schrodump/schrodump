// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { cronEvaluator } from "./wiring.js";

describe("cronEvaluator", () => {
  it("returns the most recent window at or before now — the (policyId, scheduledAt) key", () => {
    const cron = cronEvaluator("UTC");
    // An every-minute cron floors to the current minute, which is the same instant in any
    // timezone, so this stays deterministic across the dev/CI clock offset.
    const a = cron.currentWindow("* * * * *", new Date("2026-07-24T05:00:30.000Z"));
    expect(a.toISOString()).toBe("2026-07-24T05:00:00.000Z");

    // A later moment in the SAME minute yields the SAME window, so a repeated tick dedupes to one
    // job instead of creating a second.
    const b = cron.currentWindow("* * * * *", new Date("2026-07-24T05:00:59.999Z"));
    expect(b.getTime()).toBe(a.getTime());

    // The next minute advances the window.
    const c = cron.currentWindow("* * * * *", new Date("2026-07-24T05:01:05.000Z"));
    expect(c.toISOString()).toBe("2026-07-24T05:01:00.000Z");
  });

  // SC-01. The container runs UTC and no call passed a zone, so a São Paulo operator's
  // "0 2 * * *" ran at 02:00 UTC — 23:00 on their clock. The zone is the instance's now, and it
  // has to reach cron-parser. Two zones on opposite sides of UTC, so the assertion cannot pass by
  // coincidence on a machine whose own clock happens to be one of them.
  it("reads the expression on the instance's clock, not the process's", () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    expect(cronEvaluator("America/Sao_Paulo").currentWindow("0 2 * * *", now).toISOString()).toBe(
      "2026-09-21T05:00:00.000Z",
    );
    expect(cronEvaluator("Asia/Tokyo").currentWindow("0 2 * * *", now).toISOString()).toBe(
      "2026-09-20T17:00:00.000Z",
    );
    expect(cronEvaluator("UTC").currentWindow("0 2 * * *", now).toISOString()).toBe(
      "2026-09-21T02:00:00.000Z",
    );
  });

  it("throws for an expression the scheduler cannot read, rather than inventing a window", () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    expect(() => cronEvaluator("UTC").currentWindow("0 0 30 2 *", now)).toThrow();
  });
});
