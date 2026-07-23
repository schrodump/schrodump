// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real RetentionPorts wiring. Not run in CI (needs S3 + DB). Loads manifests from the bucket
// (the source of truth) and deletes both the artifact object and its manifest sidecar.

import type { Manifest } from "@schrodump/core/manifest";
import type { StorageDriver } from "@schrodump/storage/driver";
import { artifactKey, manifestKey, readManifest } from "@schrodump/storage/manifest-sidecar";
import type { RetentionPorts } from "./retention.js";

export interface RetentionWiringDeps {
  driver: StorageDriver;
  prefix: string;
  organizationId: string;
  // jobIds of the artifacts under this policy.
  artifactJobIds(): Promise<string[]>;
  // Removes the DB Artifact row (organization-scoped).
  deleteArtifactRow(jobId: string): Promise<void>;
}

export function createRetentionPorts(deps: RetentionWiringDeps): RetentionPorts {
  return {
    loadManifests: async () => {
      const manifests: Manifest[] = [];
      for (const jobId of await deps.artifactJobIds()) {
        const result = await readManifest(deps.driver, deps.prefix, deps.organizationId, jobId);
        if (result.ok) manifests.push(result.manifest);
      }
      return manifests;
    },
    deleteArtifact: async (jobId) => {
      await deps.driver.delete([
        artifactKey(deps.prefix, deps.organizationId, jobId),
        manifestKey(deps.prefix, deps.organizationId, jobId),
      ]);
      await deps.deleteArtifactRow(jobId);
    },
  };
}
