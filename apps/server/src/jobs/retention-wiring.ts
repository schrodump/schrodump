// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real RetentionPorts wiring. Not run in CI (needs S3 + DB). Loads manifests from the bucket
// (the source of truth) and deletes every object a backup wrote: the artifact, its manifest
// sidecar, and — for postgres — the globals dump beside them.

import type { Manifest } from "@schrodump/core/manifest";
import type { StorageDriver } from "@schrodump/storage/driver";
import { artifactKey, manifestKey, readManifest } from "@schrodump/storage/manifest-sidecar";
import { globalsObjectKey } from "./restore-executor.js";
import type { RetentionPorts } from "./retention.js";

export interface RetentionWiringDeps {
  driver: StorageDriver;
  prefix: string;
  organizationId: string;
  // jobIds of the artifacts under this policy.
  artifactJobIds(): Promise<string[]>;
  // jobId of the newest of those whose catalog state is VERIFIED, or null (organization-scoped).
  newestVerifiedJobId(): Promise<string | null>;
  // The keys THIS artifact was actually written under, as its catalog row records them. Null when
  // the row has gone. See deleteArtifact for why the computed keys are not enough on their own.
  recordedKeys(jobId: string): Promise<{ bucketKey: string; manifestKey: string } | null>;
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
    newestVerifiedJobId: () => deps.newestVerifiedJobId(),
    deleteArtifact: async (jobId) => {
      // Both spellings, and the reason is a defect that shipped. The write path built its keys with
      // a template literal and the read path with the shared builder, so a destination created with
      // the form's default prefix of "" wrote `/<org>/<job>/artifact.bin` while everything here
      // computed `<org>/<job>/artifact.bin`. Retention deleted the manifest (built by the shared
      // builder, so it matched), deleted the row, reported "kept 7, deleted 1" — and left
      // `artifact.bin` and `globals.bin` in the bucket forever.
      //
      // The builder is now shared (backup-wiring.ts), which stops new ones. It does not reclaim the
      // artifacts already written, because those rows still record the key they were written under
      // — so the row is asked, and both answers are deleted. DeleteObjects treats an absent key as
      // a successful delete, so naming a key that was never written costs nothing, and naming the
      // one that was is the whole point.
      const recorded = await deps.recordedKeys(jobId);
      const artifact = artifactKey(deps.prefix, deps.organizationId, jobId);
      await deps.driver.delete([
        ...(recorded === null
          ? []
          : [recorded.bucketKey, recorded.manifestKey, globalsObjectKey(recorded.bucketKey)]),
        artifact,
        manifestKey(deps.prefix, deps.organizationId, jobId),
        // A postgres backup writes a THIRD object beside those two, and nothing ever deleted it.
        // Every pruned backup left one behind, permanently: storage the operator pays for outside
        // the window they configured, and `pg_dumpall --globals-only` emits
        // `CREATE ROLE ... PASSWORD 'SCRAM-SHA-256$...'` — role password hashes surviving the
        // retention they were supposed to age out of. ARCHITECTURE.md's seventh decision puts
        // retention in the application precisely because only the application knows what a backup
        // consists of; knowing and then deleting two thirds of it is the same failure as not
        // knowing.
        //
        // Unconditional rather than gated on the engine, and that is the more careful choice:
        // DeleteObjects treats an absent key as a successful delete (S3 reports per-object failures
        // in the body, and a missing object is not one), so this costs nothing for mysql/mongo —
        // whereas deriving it from the manifest would leave the object orphaned forever in exactly
        // the case this code already handles, an unreadable manifest.
        globalsObjectKey(artifact),
      ]);
      await deps.deleteArtifactRow(jobId);
    },
  };
}
