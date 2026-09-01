// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Self-backup: dumps Schrodump's OWN metadata database to the same S3 destination.
//
// Why: if the metadata database dies, the objects in the bucket become catalog-less blobs. The
// manifest sidecar next to each artifact still allows the catalog to be reconstructed (see
// jobs/catalog-rebuild.ts), but a self-backup makes recovery direct — restore the metadata DB and
// everything is immediately addressable again.

export interface SelfBackupRecipientKey {
  readonly keyId: string;
  readonly type: "operational" | "escrow";
  readonly publicRecipient: string;
  readonly state: "active" | "retired";
}

// A self-backup is sealed to the ESCROW recipient, and that is the whole point.
//
// The operational key's identity is stored, KEK-wrapped, INSIDE the metadata database this dump
// contains. In the disaster a self-backup exists for — that database is gone — the operational
// identity went with it, so an artifact sealed only to it is a decoy: it looks like protection and
// cannot be opened. The offline escrow identity is the only one that survives the event.
//
// The operational recipient is added too, because recovering from a merely-corrupted database
// should not require fetching a key out of a safe. It is a convenience; escrow is the guarantee.
// Without an active escrow key this throws instead of writing an unopenable object.
export function selectSelfBackupRecipients(keys: SelfBackupRecipientKey[]): {
  recipients: string[];
  keyIds: string[];
} {
  const active = keys.filter((key) => key.state === "active");
  const escrow = active.find((key) => key.type === "escrow");
  if (escrow === undefined)
    throw new Error(
      "self-backup requires an active escrow key: the operational identity is stored inside the " +
        "database being dumped, so an artifact sealed without escrow could never be opened",
    );
  const operational = active.find((key) => key.type === "operational");
  const chosen = operational === undefined ? [escrow] : [escrow, operational];
  return {
    recipients: chosen.map((key) => key.publicRecipient),
    keyIds: chosen.map((key) => key.keyId),
  };
}

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

// Due-ness is computed from the last SUCCEEDED run, not from a timer, so a deployment that restarts
// more often than the interval still gets backed up — a timer would be reset by every restart and
// a daily self-backup on an hourly-deployed server would never once fire.
export function isSelfBackupDue(
  lastSucceededAt: Date | null,
  now: Date,
  intervalMs: number,
): boolean {
  if (lastSucceededAt === null) return true;
  return now.getTime() - lastSucceededAt.getTime() >= intervalMs;
}
