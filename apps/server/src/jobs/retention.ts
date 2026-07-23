// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Manifest } from "@schrodump/core/manifest";
import { RetentionOrphanError, resolveRetention, type RetentionPolicy } from "@schrodump/core/retention";

export interface RetentionPorts {
  // Manifests of the artifacts under this policy.
  loadManifests(): Promise<Manifest[]>;
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
export async function runRetention(
  policy: RetentionPolicy,
  ports: RetentionPorts,
  now: Date,
): Promise<RetentionResult> {
  const manifests = await ports.loadManifests();

  let resolution: { keep: string[]; delete: string[] };
  try {
    resolution = resolveRetention(manifests, policy, now);
  } catch (error) {
    if (error instanceof RetentionOrphanError) {
      return { kept: [], deleted: [], aborted: true, reason: error.message };
    }
    throw error;
  }

  for (const jobId of resolution.delete) {
    await ports.deleteArtifact(jobId);
  }
  return { kept: resolution.keep, deleted: resolution.delete, aborted: false, reason: null };
}
