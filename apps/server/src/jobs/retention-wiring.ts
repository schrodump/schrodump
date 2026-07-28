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
      // A sidecar that will not read is reported, never skipped. Dropping it here would hide an
      // artifact from resolveRetention entirely — it would fall out of both keep and delete, and
      // any dependency recorded only in that manifest would go unhonoured. runRetention aborts on
      // a non-empty list rather than pruning against a view it knows is partial.
      const unreadable: string[] = [];
      for (const jobId of await deps.artifactJobIds()) {
        // readManifest reports a PARSE failure through its result, but a FETCH failure — the
        // sidecar missing from the bucket, which is the likelier case here — comes back as a
        // thrown NoSuchKey from the driver. Both mean the same thing to retention: this artifact's
        // manifest cannot be read. Catching keeps one unreadable sidecar from crashing the cycle
        // into a sanitized "job failed: Error" instead of the reason that names the artifacts.
        try {
          const result = await readManifest(deps.driver, deps.prefix, deps.organizationId, jobId);
          if (result.ok) manifests.push(result.manifest);
          else unreadable.push(jobId);
        } catch {
          unreadable.push(jobId);
        }
      }
      return { manifests, unreadable };
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
