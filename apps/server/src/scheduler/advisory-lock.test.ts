// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { withAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

function fakeLock(acquire: boolean): { lock: AdvisoryLock; state: { unlocked: boolean } } {
  const state = { unlocked: false };
  const lock: AdvisoryLock = {
    tryLock: () => Promise.resolve(acquire),
    unlock: () => {
      state.unlocked = true;
      return Promise.resolve();
    },
  };
  return { lock, state };
}

describe("withAdvisoryLock", () => {
  it("runs fn and unlocks when the lock is acquired", async () => {
    const { lock, state } = fakeLock(true);
    let ran = false;
    const result = await withAdvisoryLock(lock, 42n, () => {
      ran = true;
      return Promise.resolve("done");
    });
    expect(result).toBe("done");
    expect(ran).toBe(true);
    expect(state.unlocked).toBe(true);
  });

  it("skips fn and returns null when another holder has the lock", async () => {
    const { lock, state } = fakeLock(false);
    let ran = false;
    const result = await withAdvisoryLock(lock, 42n, () => {
      ran = true;
      return Promise.resolve("done");
    });
    expect(result).toBeNull();
    expect(ran).toBe(false);
    expect(state.unlocked).toBe(false);
  });
});
