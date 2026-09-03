// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real CatalogRebuildPorts wiring. Not run in CI. Scans the bucket and reimports artifacts,
// preserving each manifest's original jobId as the BackupJob id so repeated rebuilds dedupe.

import type { PrismaClient } from "@prisma/client";
import type { StorageDriver } from "@schrodump/storage/driver";
import { scanManifests } from "@schrodump/storage/manifest-sidecar";
import { scopedPrisma } from "../data/scope.js";
import type { CatalogRebuildPorts } from "./catalog-rebuild.js";
import { dumpIsMultiDatabaseFor } from "./restore.js";

export interface CatalogRebuildWiringDeps {
  prisma: PrismaClient;
  organizationId: string;
  driver: StorageDriver;
  prefix: string;
  destinationId: string;
}

export function createCatalogRebuildPorts(deps: CatalogRebuildWiringDeps): CatalogRebuildPorts {
  const db = scopedPrisma(deps.prisma, deps.organizationId);
  return {
    scan: async () => {
      const result = await scanManifests(deps.driver, deps.prefix);
      return result.manifests.filter((m) => m.organizationId === deps.organizationId);
    },
    existingJobIds: async () => {
      const rows = await db.artifact.findMany({ select: { jobId: true } });
      return new Set(rows.map((row) => row.jobId));
    },
    importArtifact: async (manifest) => {
      // Preserve the original jobId as the BackupJob id so the artifact keeps its identity.
      //
      // upsert, not create, and `update: {}` so an existing row is left exactly as it is. The skip
      // list above is built from Artifact.jobId, which answers "is this manifest already imported"
      // — a different question from "does a BackupJob with this id exist". They come apart whenever
      // the artifact row is gone and the job row is not, which is the ordinary shape of a PARTIAL
      // catalog loss and is precisely when a rebuild gets run.
      //
      // With create() that collision threw a unique-constraint error, and because importArtifact is
      // awaited per manifest the whole rebuild aborted on the first one: a single stale job row made
      // the documented recovery floor unusable, with a 500 and no explanation. Rebuilding has to be
      // safe to run twice, and safe to run against a catalog that is only partly missing.
      await db.backupJob.upsert({
        where: { id: manifest.jobId },
        create: {
          id: manifest.jobId,
          organizationId: deps.organizationId,
          kind: "BACKUP",
          state: "SUCCEEDED",
          correlationId: `rebuild:${manifest.jobId}`,
          reason: "reconstructed from bucket manifest",
        },
        // Deliberately empty: an existing job carries its own history, and a manifest proving the
        // artifact was written is not a reason to overwrite the state that job recorded.
        update: {},
        select: { id: true },
      });
      await db.artifact.create({
        data: {
          organizationId: deps.organizationId,
          jobId: manifest.jobId,
          destinationId: deps.destinationId,
          state: "UNOBSERVED",
          bucketKey: `${deps.prefix}/${deps.organizationId}/${manifest.jobId}/artifact.bin`,
          manifestKey: `${deps.prefix}/${deps.organizationId}/${manifest.jobId}/manifest.json`,
          engine: manifest.engine,
          // From the manifest, not from the column default: a STAGED artifact is a tar, and the
          // restore pipeline only unpacks it when the row says so. Omitting this left every staged
          // artifact relabelled STREAM by the very rebuild that was supposed to recover it.
          executionMode: manifest.executionMode,
          serverVersionNum: manifest.serverVersionNum,
          // A rebuild must not silently downgrade a known-oplog artifact to unknown provenance:
          // that would make every later restore of it record a caveat it does not deserve.
          sourceHasOplog: manifest.sourceHasOplog ?? null,
          // Derived here rather than stored in the manifest, because the manifest already answers
          // it: the dump scope is what mysqldump's --databases list was. This is why an artifact
          // predating the column is not stranded — a rebuild recovers the fact from the bucket
          // without going anywhere near the origin.
          dumpIsMultiDatabase:
            dumpIsMultiDatabaseFor(
              manifest.engine,
              manifest.executionMode,
              manifest.scope.databases,
            ) ?? null,
          sizeRawBytes: BigInt(manifest.sizeRawBytes),
          sizeCompressedBytes: BigInt(manifest.sizeCompressedBytes),
          checksumAlgorithm: manifest.checksumAlgorithm,
          checksum: manifest.checksum,
          compression: manifest.compression,
          keyIds: manifest.encryption.keyIds,
          dependsOn: manifest.dependsOn,
        },
      });
    },
  };
}
