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
  it("selects STAGED for parallelism > 1, now that a directory dump can be archived", () => {
    // Only safe because buildArchiveStaging bridges a directory dump back into the single stream
    // the artifact pipeline moves. Without that bridge this selection produced an empty artifact
    // under a SUCCEEDED job, which is why the mode was withdrawn until both sides existed.
    const decision = resolveExecutionMode({ ...base, requestedParallelism: 4 });
    expect(decision.mode).toBe("STAGED");
    expect(decision.parallelism).toBe(4);
    expect(decision.warnings).toEqual([]);
  });

  it("still degrades to STREAM when parallelism is asked for without scratch", () => {
    const decision = resolveExecutionMode({
      ...base,
      requestedParallelism: 4,
      scratchConfigured: false,
    });
    expect(decision.mode).toBe("STREAM");
    expect(decision.warnings.join(" ")).toMatch(/scratch/i);
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

  it("never routes by size when no threshold is configured", () => {
    // STAGED artifacts cannot be restored or FULL_RESTORE-verified in v1. Choosing that mode FOR an
    // operator, on their largest databases, hands them an artifact they cannot restore and nobody
    // asked for. Size-based routing is therefore opt-in: absent threshold, only an explicit
    // parallelism > 1 selects STAGED.
    expect(
      resolveExecutionMode({
        requestedParallelism: base.requestedParallelism,
        scratchConfigured: base.scratchConfigured,
        stagedCapable: base.stagedCapable,
        estimatedBytes: 1_000_000_000_000,
      }).mode,
    ).toBe("STREAM");
  });

  it("a non-staged-capable engine (e.g. mongodb) is always STREAM", () => {
    const decision = resolveExecutionMode({
      ...base,
      requestedParallelism: 4,
      stagedCapable: false,
    });
    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
  });
});
