// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { resolveExecutionMode, type ExecutionModeInput } from "./execution-mode.js";

const base: ExecutionModeInput = {
  requestedParallelism: 1,
  scratchConfigured: true,
  estimatedBytes: 0,
  stagedThresholdBytes: 1000,
  stagedCapable: true,
};

describe("resolveExecutionMode", () => {
  it("precedence 1: parallelism > 1 forces STAGED when scratch is configured", () => {
    expect(resolveExecutionMode({ ...base, requestedParallelism: 4 })).toEqual({
      mode: "STAGED",
      parallelism: 4,
      warnings: [],
    });
  });

  it("precedence 2: no scratch forces STREAM and warns that parallelism is unavailable", () => {
    const decision = resolveExecutionMode({
      ...base,
      requestedParallelism: 4,
      scratchConfigured: false,
    });
    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
    expect(decision.warnings[0]).toMatch(/scratch/i);
  });

  it("precedence 3: STAGED above the size threshold, STREAM below", () => {
    expect(resolveExecutionMode({ ...base, estimatedBytes: 2000 }).mode).toBe("STAGED");
    expect(resolveExecutionMode({ ...base, estimatedBytes: 500 }).mode).toBe("STREAM");
  });

  it("a non-staged-capable engine (e.g. mongodb) is always STREAM", () => {
    const decision = resolveExecutionMode({ ...base, requestedParallelism: 4, stagedCapable: false });
    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
  });
});
