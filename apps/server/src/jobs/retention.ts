// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Manifest } from "@schrodump/core/manifest";
import {
  RetentionOrphanError,
  resolveRetention,
  retentionIsConfigured,
  type RetentionPolicy,
  type RetentionResolution,
} from "@schrodump/core/retention";

export interface LoadedManifests {
  manifests: Manifest[];
  // jobIds whose manifest could not be read back from the bucket. Reported, never dropped: an
  // artifact missing from `manifests` is invisible to resolveRetention, which would then prune
  // against an incomplete picture.
  unreadable: string[];
}

export interface RetentionPorts {
  // Manifests of the artifacts under this policy, plus the ones that could not be read.
  loadManifests(): Promise<LoadedManifests>;
  // The jobId of the policy's newest VERIFIED artifact, or null when it has none. Retention keeps
  // it whatever the counters say. The manifests cannot answer this — verification state lives on
  // the catalog row, written by a verify after the manifest was sealed — and without it the window
  // ranks by createdAt alone: a run of FAILED verifies pushes the last copy known to restore out of
  // keepLast and into the delete-set, and the job reads as an ordinary prune.
  newestVerifiedJobId(): Promise<string | null>;
  // Deletes both the artifact object AND its manifest sidecar (plus the DB row).
  deleteArtifact(jobId: string): Promise<void>;
}

export interface RetentionResult {
  kept: string[];
  deleted: string[];
  // The newest VERIFIED artifact's jobId when the window alone would have deleted it and it was
  // kept only because of what it is. Null when the window covered it, or there is none.
  newestVerifiedOutsideWindow: string | null;
  aborted: boolean;
  reason: string | null;
}

// Retention is resolved by the application (never a bucket lifecycle rule, which cannot know the
// dependsOn chain). If resolveRetention detects an orphan, the WHOLE cycle aborts and nothing is
// deleted — deleting the full while keeping incrementals is total data loss.
function abort(reason: string): RetentionResult {
  return { kept: [], deleted: [], newestVerifiedOutsideWindow: null, aborted: true, reason };
}

export async function runRetention(
  policy: RetentionPolicy,
  ports: RetentionPorts,
  now: Date,
): Promise<RetentionResult> {
  // Guard first, before any I/O. Every keep* counter defaults to 0 — in the API schema and in the
  // Prisma column — so a policy created without retention params is indistinguishable, at
  // resolveRetention's door, from one asking to keep nothing. It would answer "delete everything",
  // and this job would carry it out against every backup the policy has.
  //
  // Silence is not an instruction. An unconfigured policy prunes nothing, and says so.
  if (!retentionIsConfigured(policy)) {
    return abort("retention is not configured for this policy (every keep counter is zero)");
  }

  const { manifests, unreadable } = await ports.loadManifests();

  // An artifact whose manifest is unreadable lands in neither keep nor delete — resolveRetention
  // cannot see it, and cannot honour a dependency recorded only inside it. Pruning anyway would be
  // a decision made against a picture we know is incomplete. Same answer as the orphan case.
  if (unreadable.length > 0) {
    return abort(
      `cannot read the manifest of ${unreadable.length} artifact(s) — refusing to prune against ` +
        `an incomplete view (${unreadable.slice(0, 5).join(", ")})`,
    );
  }

  // A backup that SUCCEEDED is what chains this job, and a SUCCEEDED backup says nothing about
  // whether it restores — so "a new copy just landed" is not, on its own, what makes pruning safe.
  // Whatever the counters say, the newest copy a verify has proven survives the cycle.
  const newestVerified = await ports.newestVerifiedJobId();

  let resolution: RetentionResolution;
  try {
    resolution = resolveRetention(manifests, policy, now, {
      alwaysKeep: newestVerified === null ? [] : [newestVerified],
    });
  } catch (error) {
    if (error instanceof RetentionOrphanError) {
      return abort(error.message);
    }
    throw error;
  }

  for (const jobId of resolution.delete) {
    await ports.deleteArtifact(jobId);
  }
  return {
    kept: resolution.keep,
    deleted: resolution.delete,
    newestVerifiedOutsideWindow:
      newestVerified !== null && resolution.keptOutsideWindow.includes(newestVerified)
        ? newestVerified
        : null,
    aborted: false,
    reason: null,
  };
}

// The sentence a SUCCEEDED retention job records. A kept count above keepLast is not something to
// leave the operator to work out: when the newest VERIFIED artifact survived only because it is
// that, nothing newer than it has verified — every copy that pushed it out of the window is FAILED
// or still UNOBSERVED. That is the finding, and the reason the count reads higher than the policy
// says.
export function retentionSummary(result: RetentionResult): string {
  const counts = `retention kept ${result.kept.length}, deleted ${result.deleted.length}`;
  if (result.newestVerifiedOutsideWindow === null) return counts;
  return (
    `${counts} — kept ${result.newestVerifiedOutsideWindow} outside the window: it is the newest ` +
    `VERIFIED artifact, and nothing newer has verified`
  );
}
