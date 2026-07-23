// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Self-backup: dumps Schrodump's OWN metadata database to the same S3 destination.
//
// Why: if the metadata database dies, the objects in the bucket become catalog-less blobs. The
// manifest sidecar next to each artifact still allows the catalog to be reconstructed (see
// jobs/catalog-rebuild.ts), but a self-backup makes recovery direct — restore the metadata DB and
// everything is immediately addressable again.

export interface SelfBackupUpload {
  bucketKey: string;
  manifestKey: string;
  sizeBytes: number;
  checksum: string;
}

export interface SelfBackupPorts {
  setState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  // pg_dump of the metadata DB -> compress -> encrypt -> upload, same pipeline order as a backup.
  dumpAndUpload(): Promise<SelfBackupUpload>;
  writeManifest(upload: SelfBackupUpload): Promise<void>;
}

export interface SelfBackupOutcome {
  ok: boolean;
  bucketKey: string | null;
}

export async function runSelfBackup(ports: SelfBackupPorts): Promise<SelfBackupOutcome> {
  await ports.setState("RUNNING");
  try {
    const upload = await ports.dumpAndUpload();
    await ports.writeManifest(upload);
    await ports.setState("SUCCEEDED");
    return { ok: true, bucketKey: upload.bucketKey };
  } catch (error) {
    await ports.setState("FAILED", error instanceof Error ? error.message : "self-backup error");
    return { ok: false, bucketKey: null };
  }
}
