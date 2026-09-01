// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export type ExecutionMode = "STREAM" | "STAGED";

export interface ExecutionModeInput {
  requestedParallelism: number;
  scratchConfigured: boolean;
  estimatedBytes: number;
  // Dumps above this go STAGED. OPTIONAL, and absent by default: STAGED artifacts cannot be
  // restored or FULL_RESTORE-verified in v1, so routing there without being asked hands the
  // operator an artifact they cannot restore — and it would do so on their LARGEST databases
  // first. Absent means size never selects the mode; only an explicit parallelism > 1 does.
  stagedThresholdBytes?: number;
  // From the capability matrix: mongodb, for example, is not staged-capable.
  stagedCapable: boolean;
  // Also from the capability matrix, and required rather than optional so a caller cannot decide
  // parallelism without one. It was declared per engine (8 for the SQL engines, 1 for mongo) and
  // read by nothing: the policy schema is min(1) with no upper bound, so the requested value
  // reached `pg_dump -j` unchanged. A policy asking for 500 opened 500 connections against the
  // customer's production database — a backup tool taking down the thing it exists to protect.
  maxParallelism: number;
}

export interface ExecutionModeDecision {
  mode: ExecutionMode;
  parallelism: number;
  // Human-readable reasons for a degradation, surfaced in the UI (e.g. parallelism unavailable).
  warnings: string[];
}

// Precedence:
//   0. engine not staged-capable       -> STREAM (parallelism 1)
//   1. parallelism > 1 requested        -> STAGED (needs scratch), clamped to the engine's
//                                          maxParallelism; without scratch -> STREAM + warning
//   2. otherwise                        -> STAGED above the size threshold, STREAM below
// STAGED writes a DIRECTORY dump and the artifact pipeline moves a single stream. The bridge is
// buildArchiveStaging: after the dump, a second run tars the staging directory to stdout and THAT
// becomes the artifact. Before that bridge existed, a STAGED backup uploaded an empty stream while
// the dump tool exited 0 — a SUCCEEDED job over an artifact holding no data. The mode is only safe
// to select because the archive step, the extract step on restore, and the verify path now all
// exist together.
export function resolveExecutionMode(input: ExecutionModeInput): ExecutionModeDecision {
  if (!input.stagedCapable) {
    const warnings =
      input.requestedParallelism > 1
        ? ["parallelism unavailable: this engine does not support staged parallel dumps"]
        : [];
    return { mode: "STREAM", parallelism: 1, warnings };
  }

  if (input.requestedParallelism > 1) {
    if (input.scratchConfigured) {
      // Clamped, not refused: the backup should still run. But the operator has to learn that the
      // number they chose is not the number being used, or the ceiling is invisible until someone
      // wonders why a dump is no faster at 64 than at 8.
      const parallelism = Math.min(input.requestedParallelism, input.maxParallelism);
      const warnings =
        parallelism < input.requestedParallelism
          ? [`parallelism reduced to ${String(parallelism)}: the highest this engine supports`]
          : [];
      return { mode: "STAGED", parallelism, warnings };
    }
    return {
      mode: "STREAM",
      parallelism: 1,
      warnings: ["parallelism unavailable: scratch is not configured on this deploy"],
    };
  }

  if (!input.scratchConfigured) {
    return { mode: "STREAM", parallelism: 1, warnings: [] };
  }

  // Explicit, rather than leaning on `n > undefined` evaluating false: that reads as a bug to the
  // next person, and it is one comparison away from silently becoming one.
  const threshold = input.stagedThresholdBytes;
  if (threshold !== undefined && input.estimatedBytes > threshold) {
    return { mode: "STAGED", parallelism: 1, warnings: [] };
  }
  return { mode: "STREAM", parallelism: 1, warnings: [] };
}
