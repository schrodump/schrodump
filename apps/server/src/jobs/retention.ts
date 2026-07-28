// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Manifest } from "@schrodump/core/manifest";
import {
  RetentionOrphanError,
  resolveRetention,
  retentionIsConfigured,
  type RetentionPolicy,
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
  // Deletes both the artifact object AND its manifest sidecar (plus the DB row).
  deleteArtifact(jobId: string): Promise<void>;
}

export interface RetentionResult {
  kept: string[];
  deleted: string[];
  aborted: boolean;
  reason: string | null;
}

// Retention is resolved by the application (never a bucket lifecycle rule, which cannot know the
// dependsOn chain). If resolveRetention detects an orphan, the WHOLE cycle aborts and nothing is
// deleted — deleting the full while keeping incrementals is total data loss.
function abort(reason: string): RetentionResult {
  return { kept: [], deleted: [], aborted: true, reason };
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

  let resolution: { keep: string[]; delete: string[] };
  try {
    resolution = resolveRetention(manifests, policy, now);
  } catch (error) {
    if (error instanceof RetentionOrphanError) {
      return abort(error.message);
    }
    throw error;
  }

  for (const jobId of resolution.delete) {
    await ports.deleteArtifact(jobId);
  }
  return { kept: resolution.keep, deleted: resolution.delete, aborted: false, reason: null };
}
