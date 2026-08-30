// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { runGracefulShutdown } from "./shutdown.js";

const fakeLog = { info: vi.fn() };

describe("runGracefulShutdown", () => {
  it("stops loops, aborts, awaits idle, disconnects — in order", async () => {
    const order: string[] = [];
    const controller = { abort: vi.fn(() => order.push("abort")) };
    const handle = {
      stop: vi.fn(() => order.push("stopWorker")),
      whenIdle: vi.fn(() => {
        order.push("whenIdle");
        return Promise.resolve();
      }),
    };
    const scheduler = { stop: vi.fn(() => order.push("stopScheduler")) };
    const disconnect = vi.fn(async () => {
      order.push("disconnect");
    });
    await runGracefulShutdown({
      handle,
      scheduler,
      controller,
      disconnect,
      graceMs: 8000,
      log: fakeLog,
    });
    expect(order).toEqual(["stopWorker", "stopScheduler", "abort", "whenIdle", "disconnect"]);
  });

  it("proceeds to disconnect when the drain outlasts the grace", async () => {
    vi.useFakeTimers();
    try {
      const disconnect = vi.fn(async () => {});
      const p = runGracefulShutdown({
        handle: { stop: vi.fn(), whenIdle: () => new Promise(() => {}) }, // never idle
        scheduler: { stop: vi.fn() },
        controller: { abort: vi.fn() },
        disconnect,
        graceMs: 8000,
        log: fakeLog,
      });
      await vi.advanceTimersByTimeAsync(8000);
      await p;
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait forever on a wedged disconnect", async () => {
    vi.useFakeTimers();
    try {
      // The drain finishes promptly; the disconnect is what hangs. Before the disconnect was
      // bounded, this shutdown never completed and the process sat past the docker stop window
      // until SIGKILL — the one outcome the grace exists to avoid.
      const p = runGracefulShutdown({
        handle: { stop: vi.fn(), whenIdle: () => Promise.resolve() },
        scheduler: { stop: vi.fn() },
        controller: { abort: vi.fn() },
        disconnect: () => new Promise(() => {}), // never settles
        graceMs: 8000,
        log: fakeLog,
      });
      await vi.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("always disconnects, even when whenIdle resolves well within the grace", async () => {
    const disconnect = vi.fn(async () => {});
    await runGracefulShutdown({
      handle: { stop: vi.fn(), whenIdle: () => Promise.resolve() },
      scheduler: { stop: vi.fn() },
      controller: { abort: vi.fn() },
      disconnect,
      graceMs: 8000,
      log: fakeLog,
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
