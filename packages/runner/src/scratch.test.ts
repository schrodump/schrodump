// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchrodumpError } from "@schrodump/core/errors";
import { ScratchManager } from "./scratch.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "schrodump-scratch-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ScratchManager.reserve", () => {
  it("refuses the job when the estimate does not fit with the safety margin, and frees the slot", async () => {
    let free = 100;
    const manager = new ScratchManager({
      root,
      maxConcurrentStaged: 1,
      safetyFactor: 1.5,
      freeSpaceProbe: () => Promise.resolve(free),
    });

    await expect(manager.reserve("job1", 1000)).rejects.toBeInstanceOf(SchrodumpError);
    expect(await exists(join(root, "job1"))).toBe(false);

    // the single slot was released on failure, so a fitting job can still reserve it
    free = 10_000;
    const reservation = await manager.reserve("job2", 1000);
    expect(await exists(reservation.path)).toBe(true);
    await reservation.release();
  });
});

describe("Reservation.release", () => {
  it("deletes the directory even when the run throws", async () => {
    const manager = new ScratchManager({
      root,
      maxConcurrentStaged: 2,
      freeSpaceProbe: () => Promise.resolve(10_000),
    });
    const reservation = await manager.reserve("job1", 100);

    await expect(
      (async () => {
        try {
          throw new Error("dump failed");
        } finally {
          await reservation.release();
        }
      })(),
    ).rejects.toThrow("dump failed");

    expect(await exists(reservation.path)).toBe(false);
  });
});

describe("ScratchManager.gc", () => {
  it("removes an aged orphan, preserves a recent orphan and an active job's directory", async () => {
    const manager = new ScratchManager({
      root,
      maxConcurrentStaged: 2,
      maxAgeMs: 1000,
      freeSpaceProbe: () => Promise.resolve(10_000),
    });

    const active = await manager.reserve("active-job", 100);

    await mkdir(join(root, "orphan-old"), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, "orphan-old"), old, old);

    await mkdir(join(root, "orphan-recent"), { recursive: true }); // mtime ~now, under the ceiling

    const removed = await manager.gc();

    expect(removed).toContain("orphan-old");
    expect(removed).not.toContain("orphan-recent");
    expect(await exists(join(root, "orphan-old"))).toBe(false);
    expect(await exists(join(root, "orphan-recent"))).toBe(true);
    expect(await exists(active.path)).toBe(true); // active job never touched

    await active.release();
  });
});

describe("ScratchManager semaphore", () => {
  it("blocks reservations beyond the configured maximum", async () => {
    const manager = new ScratchManager({
      root,
      maxConcurrentStaged: 1,
      freeSpaceProbe: () => Promise.resolve(10_000),
    });
    const first = await manager.reserve("job1", 100);

    let secondAcquired = false;
    const secondPromise = manager.reserve("job2", 100).then((reservation) => {
      secondAcquired = true;
      return reservation;
    });

    await delay(20);
    expect(secondAcquired).toBe(false); // blocked while the only slot is held

    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  });
});
