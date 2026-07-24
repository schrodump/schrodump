// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { cronEvaluator } from "./wiring.js";

describe("cronEvaluator", () => {
  it("returns the most recent window at or before now — the (policyId, scheduledAt) key", () => {
    const cron = cronEvaluator();
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
});
