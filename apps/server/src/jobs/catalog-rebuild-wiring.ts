// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real CatalogRebuildPorts wiring. Not run in CI. Scans the bucket and reimports artifacts,
// preserving each manifest's original jobId as the BackupJob id so repeated rebuilds dedupe.

import type { PrismaClient } from "@prisma/client";
import type { StorageDriver } from "@schrodump/storage/driver";
import { scanManifests } from "@schrodump/storage/manifest-sidecar";
import { scopedPrisma } from "../data/scope.js";
import type { CatalogRebuildPorts } from "./catalog-rebuild.js";

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
      await db.backupJob.create({
        data: {
          id: manifest.jobId,
          organizationId: deps.organizationId,
          kind: "BACKUP",
          state: "SUCCEEDED",
          correlationId: `rebuild:${manifest.jobId}`,
          reason: "reconstructed from bucket manifest",
        },
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
          serverVersionNum: manifest.serverVersionNum,
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
