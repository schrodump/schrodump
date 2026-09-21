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
  singleDatabaseStagingScope: null,
  stagedTlsRefusal: null,
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
        singleDatabaseStagingScope: base.singleDatabaseStagingScope,
        stagedTlsRefusal: base.stagedTlsRefusal,
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

// mydumper is handed `-B <db>` and copies exactly that database. An unscoped mysql target connects
// through `mysql`, the system schema, so parallelism > 1 used to STAGE `mysql` alone: the job
// SUCCEEDED, the artifact held no user data, and the unscoped verify — downgraded to CHECKSUM —
// made it VERIFIED. A multi-database selection kept only its first database the same way.
describe("resolveExecutionMode — a single-database stager", () => {
  const mysql = (scope: string[]): ExecutionModeInput => ({ ...base, singleDatabaseStagingScope: scope });

  it("streams an unscoped target that asked for parallelism, and says why", () => {
    const decision = resolveExecutionMode({ ...mysql([]), requestedParallelism: 4 });

    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
    expect(decision.warnings).toEqual([
      "staged unavailable: mydumper dumps a single database and this target is unscoped — streamed instead",
    ]);
  });

  it("streams a target that selects two databases, rather than keep the first", () => {
    const decision = resolveExecutionMode({ ...mysql(["shop", "billing"]), requestedParallelism: 4 });

    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
    expect(decision.warnings).toEqual([
      "staged unavailable: mydumper dumps a single database and this target selects 2 databases — streamed instead",
    ]);
  });

  it("stages a target that selects exactly one database, at the parallelism it asked for", () => {
    const decision = resolveExecutionMode({ ...mysql(["shop"]), requestedParallelism: 4 });

    expect(decision.mode).toBe("STAGED");
    expect(decision.parallelism).toBe(4);
    expect(decision.warnings).toEqual([]);
  });

  it("holds on the size-threshold path too, which reaches STAGED without any parallelism", () => {
    const decision = resolveExecutionMode({ ...mysql([]), estimatedBytes: 5000, stagedThresholdBytes: 1000 });

    expect(decision.mode).toBe("STREAM");
    expect(decision.warnings.join(" ")).toMatch(/unscoped/);
    // And a single database still stages above the threshold.
    expect(
      resolveExecutionMode({ ...mysql(["shop"]), estimatedBytes: 5000, stagedThresholdBytes: 1000 }).mode,
    ).toBe("STAGED");
  });

  it("reads a legacy empty-string entry as unscoped, not as one database named nothing", () => {
    const decision = resolveExecutionMode({ ...mysql([""]), requestedParallelism: 4 });

    expect(decision.mode).toBe("STREAM");
    expect(decision.warnings.join(" ")).toMatch(/unscoped/);
  });

  it("says nothing when STAGED was never going to be chosen", () => {
    // Parallelism 1 below the threshold streams anyway; a warning would describe a degradation
    // that did not happen.
    expect(resolveExecutionMode(mysql([]))).toEqual({ mode: "STREAM", parallelism: 1, warnings: [] });
  });

  it("keeps the missing-scratch reason when that is what stopped STAGED first", () => {
    const decision = resolveExecutionMode({ ...mysql([]), requestedParallelism: 4, scratchConfigured: false });

    expect(decision.mode).toBe("STREAM");
    expect(decision.warnings).toEqual(["parallelism unavailable: scratch is not configured on this deploy"]);
  });

  it("leaves an engine that passes null — postgres — staging as before", () => {
    const decision = resolveExecutionMode({ ...base, requestedParallelism: 4 });

    expect(decision.mode).toBe("STAGED");
    expect(decision.parallelism).toBe(4);
  });
});

// mydumper and myloader fall back to plaintext under --ssl-mode=REQUIRED (measured against
// schrodump/mydumper:1), so a mysql/mariadb target with TLS on and no CA must never be staged. The
// refusal text comes from the adapter; what is asserted here is that it wins over BOTH ways into
// STAGED, and says so, and that a target without one is untouched.
describe("resolveExecutionMode — a staged tool that cannot honour the target's TLS", () => {
  const refusal =
    "mydumper and myloader cannot require TLS without verifying the server's certificate — they " +
    "fall back to plaintext when the server offers none";

  it("streams an explicit parallelism request instead, with the reason", () => {
    const decision = resolveExecutionMode({ ...base, requestedParallelism: 4, stagedTlsRefusal: refusal });
    expect(decision.mode).toBe("STREAM");
    expect(decision.parallelism).toBe(1);
    expect(decision.warnings).toEqual([
      `staged unavailable: ${refusal}, and this TLS target has no CA certificate — streamed instead`,
    ]);
  });

  it("streams a size-routed dump instead, with the reason", () => {
    const decision = resolveExecutionMode({ ...base, estimatedBytes: 5000, stagedTlsRefusal: refusal });
    expect(decision.mode).toBe("STREAM");
    expect(decision.warnings[0]).toMatch(/fall back to plaintext/);
  });

  it("stages exactly as before when the tool can honour it", () => {
    expect(resolveExecutionMode({ ...base, requestedParallelism: 4 }).mode).toBe("STAGED");
    expect(resolveExecutionMode({ ...base, estimatedBytes: 5000 }).mode).toBe("STAGED");
  });

  it("says nothing about TLS when STAGED was never going to be chosen", () => {
    const decision = resolveExecutionMode({ ...base, stagedTlsRefusal: refusal });
    expect(decision).toEqual({ mode: "STREAM", parallelism: 1, warnings: [] });
  });
});
