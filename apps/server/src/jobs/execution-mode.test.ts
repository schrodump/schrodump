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
  it("degrades to a single stream instead of producing an empty STAGED artifact", () => {
    // STAGED writes a DIRECTORY dump, but the upload path reads the container's stdout — so a
    // STAGED backup uploaded an empty stream (gzip+age headers, ~318 bytes) while pg_dump exited 0.
    // Verified against a real 545MB database: the job read SUCCEEDED and the artifact held no data,
    // with the real dump deleted along with the scratch reservation. A CHECKSUM verify would then
    // mark that empty object VERIFIED, because it does check out against its own manifest.
    // Until a directory upload pipeline exists, a real single-stream backup beats a fast lie.
    const decision = resolveExecutionMode({ ...base, requestedParallelism: 4 });
    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
    expect(decision.warnings.join(" ")).toMatch(/staged/i);
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
