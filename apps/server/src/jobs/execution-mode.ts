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
  // The databases the target names, for an engine whose STAGED dump copies exactly ONE database by
  // name — mysql/mariadb, where STAGED is `mydumper -B <db>` — and null for an engine whose STAGED
  // dump covers what its STREAM dump covers (postgres: `-Fd` and `-Fc` both copy the database the
  // connection opens, which the target route pins to one). An empty list is an unscoped target.
  //
  // Required, not optional, for the reason maxParallelism is. Nothing asked this question, and an
  // unscoped mysql target with parallelism > 1 went STAGED: mydumper was handed `-B mysql` — the
  // SYSTEM schema, the database an unscoped target connects through — the job SUCCEEDED over an
  // artifact holding no user data, and the unscoped verify, downgraded to CHECKSUM, made it
  // VERIFIED. A multi-database selection kept only its first database the same way. A default here
  // is how the next caller would reintroduce it.
  singleDatabaseStagingScope: readonly string[] | null;
}

export interface ExecutionModeDecision {
  mode: ExecutionMode;
  parallelism: number;
  // Human-readable reasons for a degradation (e.g. parallelism unavailable). runBackupJob writes
  // them as the SUCCEEDED job's reason, where the jobs ledger shows them, and the worker logs them
  // with the job id.
  warnings: string[];
}

// Precedence:
//   0. engine not staged-capable       -> STREAM (parallelism 1)
//   1. parallelism > 1 requested        -> STAGED (needs scratch), clamped to the engine's
//                                          maxParallelism; without scratch -> STREAM + warning
//   2. otherwise                        -> STAGED above the size threshold, STREAM below
// Whenever 1 or 2 would pick STAGED for a single-database stager whose target does not name
// exactly one database, the answer is STREAM + warning instead: the stream dump copies every
// database in scope, and the staged one would copy one of them — or the system schema — silently.
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
      const refusal = stagingScopeRefusal(input.singleDatabaseStagingScope);
      if (refusal !== null) return { mode: "STREAM", parallelism: 1, warnings: [refusal] };
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
    const refusal = stagingScopeRefusal(input.singleDatabaseStagingScope);
    if (refusal !== null) return { mode: "STREAM", parallelism: 1, warnings: [refusal] };
    return { mode: "STAGED", parallelism: 1, warnings: [] };
  }
  return { mode: "STREAM", parallelism: 1, warnings: [] };
}

// Why a single-database stager cannot copy what this target asks for, or null when it can. Judged
// the way probeDatabaseFor picks the database mydumper is pointed at — the first entry, non-empty —
// so a legacy [""] reads as unscoped here too, rather than as one database named nothing.
function stagingScopeRefusal(scope: readonly string[] | null): string | null {
  if (scope === null) return null;
  const first = scope[0];
  if (scope.length === 1 && first !== undefined && first.length > 0) return null;
  const what = scope.length <= 1 ? "is unscoped" : `selects ${String(scope.length)} databases`;
  return `staged unavailable: mydumper dumps a single database and this target ${what} — streamed instead`;
}
