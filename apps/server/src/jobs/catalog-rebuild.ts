// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Manifest } from "@schrodump/core/manifest";

// Disaster-recovery path: scans the bucket via scanManifests and reimports artifacts missing from
// the metadata database. It MUST work with an empty database — that is the whole point.

export interface CatalogRebuildPorts {
  // Manifests read from the bucket (the source of truth).
  scan(): Promise<Manifest[]>;
  // jobIds already present in the metadata DB.
  existingJobIds(): Promise<Set<string>>;
  // Reimports one artifact. Its state is UNOBSERVED — reconstruction never assumes a past verify.
  importArtifact(manifest: Manifest): Promise<void>;
}

export interface CatalogRebuildResult {
  scanned: number;
  imported: string[];
  skipped: string[];
}

export async function rebuildCatalog(ports: CatalogRebuildPorts): Promise<CatalogRebuildResult> {
  const manifests = await ports.scan();
  const existing = await ports.existingJobIds();

  const imported: string[] = [];
  const skipped: string[] = [];
  for (const manifest of manifests) {
    if (existing.has(manifest.jobId)) {
      skipped.push(manifest.jobId);
      continue;
    }
    await ports.importArtifact(manifest);
    imported.push(manifest.jobId);
  }
  return { scanned: manifests.length, imported, skipped };
}
