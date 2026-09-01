// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdown, startLoop } from "./loop.js";

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

  it("whenIdle() resolves only after an in-flight tick settles", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
      const loop = startLoop({ tick, intervalMs: 1 });
      await vi.advanceTimersByTimeAsync(1); // let one tick start
      let resolved = false;
      const idle = loop.whenIdle().then(() => (resolved = true));
      await Promise.resolve();
      expect(resolved).toBe(false); // tick still running
      release();
      await idle;
      expect(resolved).toBe(true);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("whenIdle() resolves immediately when no tick is running", async () => {
    const loop = startLoop({ tick: vi.fn(async () => {}), intervalMs: 10_000 });
    await expect(loop.whenIdle()).resolves.toBeUndefined();
    loop.stop();
  });
});

describe("installShutdown", () => {
  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("survives the same signal arriving twice", async () => {
    // The packaged image delivers SIGTERM TWICE on one `docker stop`: dumb-init broadcasts to the
    // process group AND entrypoint.sh forwards it explicitly. With process.once the second arrival
    // finds no listener, so Node's default action terminates the process mid-cleanup — the executor
    // container is orphaned, the cleartext scratch survives and the job stays RUNNING. Verified
    // against the built image: one signal completes the shutdown in 86ms; two never complete it.
    let started = 0;
    let release: () => void = () => undefined;
    const exits: number[] = [];
    installShutdown(
      {
        onSignal: () => {
          started += 1;
          return new Promise<void>((r) => {
            release = r;
          });
        },
      },
      () => exits.push(1),
    );

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    expect(started).toBe(1); // the second is ignored, not re-entered
    expect(exits).toEqual([]); // and it did not exit before the first finished

    release();
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([1]);
  });

  it("exits even when the shutdown sequence rejects", async () => {
    // A failing shutdown must still exit, or the container hangs until SIGKILL for a reason nobody
    // can see.
    const exits: number[] = [];
    installShutdown({ onSignal: () => Promise.reject(new Error("boom")) }, () => exits.push(1));
    process.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([1]);
  });
});
