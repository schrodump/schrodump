// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = { DATABASE_URL: "postgres://x", SCHRODUMP_KEK: "k" };

describe("loadEnv worker config", () => {
  it("applies defaults when the worker vars are absent", () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.SCHRODUMP_SCRATCH_PATH).toBeUndefined();
    expect(env.SCHRODUMP_SCRATCH_MAX_BYTES).toBe(107374182400);
    expect(env.SCHRODUMP_MAX_CONCURRENT_STAGED).toBe(2);
    expect(env.SCHRODUMP_EXECUTOR_NETWORK).toBe("schrodump_targets");
    expect(env.WORKER_POLL_MS).toBe(2000);
  });

  it("coerces the numeric vars", () => {
    const env = loadEnv({
      ...base,
      SCHRODUMP_SCRATCH_PATH: "/scratch",
      SCHRODUMP_SCRATCH_MAX_BYTES: "1024",
      SCHRODUMP_MAX_CONCURRENT_STAGED: "4",
      WORKER_POLL_MS: "500",
    } as NodeJS.ProcessEnv);
    expect(env.SCHRODUMP_SCRATCH_PATH).toBe("/scratch");
    expect(env.SCHRODUMP_SCRATCH_MAX_BYTES).toBe(1024);
    expect(env.SCHRODUMP_MAX_CONCURRENT_STAGED).toBe(4);
    expect(env.WORKER_POLL_MS).toBe(500);
  });
});
