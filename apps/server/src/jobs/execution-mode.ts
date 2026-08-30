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
}

export interface ExecutionModeDecision {
  mode: ExecutionMode;
  parallelism: number;
  // Human-readable reasons for a degradation, surfaced in the UI (e.g. parallelism unavailable).
  warnings: string[];
}

// Precedence:
//   0. engine not staged-capable       -> STREAM (parallelism 1)
//   1. parallelism > 1 requested        -> STAGED (needs scratch); without scratch -> STREAM + warning
//   2. otherwise                        -> STAGED above the size threshold, STREAM below
// STAGED is unreachable ON PURPOSE, and this is not a style choice. A staged dump writes a
// DIRECTORY (pg_dump -Fd, mydumper), but the upload path reads the container's STDOUT — nothing
// ever reads that directory back. A STAGED backup therefore uploaded an empty stream: gzip and age
// headers, 318 bytes, while the dump tool exited 0. Verified against a real 545 MB database: the
// job read SUCCEEDED, the artifact held no data, and the real dump was deleted with the scratch
// reservation. Worse, restore refuses STAGED artifacts and verify downgrades them to CHECKSUM — and
// a CHECKSUM verify PASSES on those 318 bytes, because they do match their own manifest. The
// product's central claim, VERIFIED, was reachable on an empty file.
//
// Until a directory upload pipeline exists (untar-to-directory on the way back too — see
// runRestoreJob's matching refusal), a real single-stream dump beats a fast lie. The mode stays in
// the type because the pipeline is a planned follow-up, not an abandoned idea.
const STAGED_UNAVAILABLE =
  "parallelism unavailable: staged (directory) dumps cannot be uploaded yet, so this ran as a single-stream dump";

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
      return { mode: "STREAM", parallelism: 1, warnings: [STAGED_UNAVAILABLE] };
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
    return { mode: "STREAM", parallelism: 1, warnings: [STAGED_UNAVAILABLE] };
  }
  return { mode: "STREAM", parallelism: 1, warnings: [] };
}
