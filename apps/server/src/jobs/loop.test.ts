// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { startLoop } from "./loop.js";

describe("startLoop", () => {
  it("runs the tick on each interval and stops cleanly", async () => {
    const tick = vi.fn(() => Promise.resolve(1));
    const handle = startLoop({ tick, intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 25));
    handle.stop();
    const callsAtStop = tick.mock.calls.length;
    expect(callsAtStop).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(tick.mock.calls.length).toBe(callsAtStop); // no ticks after stop
  });

  it("never overlaps ticks", async () => {
    let active = 0;
    let sawOverlap = false;
    const tick = vi.fn(async () => {
      active += 1;
      if (active > 1) sawOverlap = true;
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 0;
    });
    const handle = startLoop({ tick, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();
    expect(sawOverlap).toBe(false);
    expect(tick.mock.calls.length).toBeGreaterThan(1);
  });
});
