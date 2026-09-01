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
  maxParallelism: 8,
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
        maxParallelism: base.maxParallelism,
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

// The capability matrix declares maxParallelism per engine — 8 for the SQL engines, 1 for mongo —
// and nothing read it. The policy schema is `min(1)` with no upper bound, so the requested value
// reached pg_dump -j unchanged: a policy asking for 500 opened 500 connections against the
// customer's production database. A backup tool taking its own target down is the failure this
// clamp exists to prevent.
describe("resolveExecutionMode — the engine's parallelism ceiling", () => {
  it("clamps a request above the engine's maximum, and says so", () => {
    const decision = resolveExecutionMode({
      ...base,
      requestedParallelism: 500,
      maxParallelism: 8,
    });

    expect(decision.mode).toBe("STAGED");
    expect(decision.parallelism).toBe(8);
    // A warning rather than a refusal: the backup should still run, and the operator should learn
    // that the number they chose is not the number being used.
    expect(decision.warnings).toEqual([
      "parallelism reduced to 8: the highest this engine supports",
    ]);
  });

  it("leaves a request at or below the ceiling untouched", () => {
    for (const requested of [2, 8]) {
      const decision = resolveExecutionMode({ ...base, requestedParallelism: requested, maxParallelism: 8 });
      expect(decision.parallelism).toBe(requested);
      expect(decision.warnings).toEqual([]);
    }
  });

  it("keeps the not-staged-capable rule ahead of the ceiling", () => {
    // mongo declares maxParallelism 1 AND stagedCapable false. The existing rule already forces
    // STREAM at 1, and it must keep winning — a clamp warning there would describe a degradation
    // that is not the one that happened.
    const decision = resolveExecutionMode({
      ...base,
      requestedParallelism: 4,
      maxParallelism: 1,
      stagedCapable: false,
    });

    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
    expect(decision.warnings).toEqual([
      "parallelism unavailable: this engine does not support staged parallel dumps",
    ]);
  });
});
