// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { startWorker } from "./worker-loop.js";

describe("startWorker", () => {
  it("drains on each tick and stops cleanly", async () => {
    const drainQueue = vi.fn(() => Promise.resolve(1));
    const handle = startWorker({ drainQueue, intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 25));
    handle.stop();
    const callsAtStop = drainQueue.mock.calls.length;
    expect(callsAtStop).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(drainQueue.mock.calls.length).toBe(callsAtStop); // no ticks after stop
  });

  it("never overlaps drains", async () => {
    let active = 0;
    let sawOverlap = false;
    const drainQueue = vi.fn(async () => {
      active += 1;
      if (active > 1) sawOverlap = true;
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 0;
    });
    const handle = startWorker({ drainQueue, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();
    expect(sawOverlap).toBe(false);
  });
});
