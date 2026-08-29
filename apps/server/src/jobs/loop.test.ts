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

  it("whenIdle resolves only after the in-flight tick settles", async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<number>((r) => {
      release = () => r(0);
    }));
    const handle = startLoop({ tick, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 10)); // a tick is now in flight
    handle.stop();

    let settled = false;
    const idle = handle.whenIdle().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // still waiting on the tick

    release();
    await idle;
    expect(settled).toBe(true);
  });

  it("whenIdle resolves immediately when no tick is running", async () => {
    const handle = startLoop({ tick: () => Promise.resolve(0), intervalMs: 10_000 });
    handle.stop();
    await expect(handle.whenIdle()).resolves.toBeUndefined();
  });

  it("whenIdle resolves even when the in-flight tick rejects", async () => {
    let fail: (err: Error) => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<number>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const handle = startLoop({ tick, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 10)); // a tick is in flight and still pending
    handle.stop();
    expect(tick).toHaveBeenCalled(); // guards the test against vacuously passing on an idle loop

    // Captured BEFORE the rejection: this is the in-flight promise, not the idle shortcut.
    const idle = handle.whenIdle();
    fail(new Error("drain blew up"));
    // Resolves, never rejects — a tick that threw is still a tick that finished, and shutdown
    // must not be derailed by the failure of the work it is waiting out.
    await expect(idle).resolves.toBeUndefined();
  });
});
