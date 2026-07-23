// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { resolveDecryptionKeyId, type EncryptionKeyRecord } from "../crypto/artifact.js";

export type RestoreTarget = "FULL_CLUSTER" | "DATABASE" | "SCHEMA" | "TABLE" | "COLLECTION";

export interface RestoreRequest {
  jobId: string;
  artifactId: string;
  organizationId: string;
  userId: string;
  target: RestoreTarget;
  // Must be explicitly true to restore over a database that already holds data — never a default.
  confirmExistingDatabase: boolean;
}

export interface ArtifactForRestore {
  manifestKeyIds: string[];
  engine: string;
  supportedRestoreTargets: RestoreTarget[];
  destinationName: string;
}

export interface RestorePorts {
  loadArtifact(): Promise<ArtifactForRestore>;
  // ALL keys (active + retired) — an artifact may have been encrypted with a now-retired key.
  availableKeys(): Promise<EncryptionKeyRecord[]>;
  targetHasExistingData(): Promise<boolean>;
  // who / when / which artifact / which destination — restore is always audited.
  audit(event: {
    action: string;
    artifactId: string;
    userId: string;
    destinationName: string;
    keyId: string;
  }): Promise<void>;
  setJobState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  runRestore(keyId: string): Promise<boolean>;
}

export interface RestoreOutcome {
  ok: boolean;
  keyId: string | null;
  error: string | null;
}

export async function runRestoreJob(
  req: RestoreRequest,
  ports: RestorePorts,
): Promise<RestoreOutcome> {
  await ports.setJobState("RUNNING");
  try {
    const artifact = await ports.loadArtifact();

    // 1. Validate the target against the capability matrix — a single-table restore of an artifact
    //    that lacks that granularity is a clear error, not a partial attempt.
    if (!artifact.supportedRestoreTargets.includes(req.target)) {
      return await fail(ports, `restore target ${req.target} is not supported for ${artifact.engine} artifacts`);
    }

    // 2. Resolve the decryption key from the manifest's keyIds (retired keys included), never from
    //    global config.
    const keyId = resolveDecryptionKeyId(artifact.manifestKeyIds, await ports.availableKeys());
    if (keyId === null) {
      return await fail(ports, "no server-held identity matches this artifact (sealed) — supply an identity in memory");
    }

    // 3. Restore over existing data requires explicit confirmation.
    if ((await ports.targetHasExistingData()) && !req.confirmExistingDatabase) {
      return await fail(ports, "restore over an existing database requires explicit confirmation");
    }

    // 4. Audit the restore, then execute.
    await ports.audit({
      action: "restore.execute",
      artifactId: req.artifactId,
      userId: req.userId,
      destinationName: artifact.destinationName,
      keyId,
    });
    const ok = await ports.runRestore(keyId);
    await ports.setJobState(ok ? "SUCCEEDED" : "FAILED");
    return { ok, keyId, error: ok ? null : "restore failed" };
  } catch (error) {
    return await fail(ports, error instanceof Error ? error.message : "restore error");
  }
}

async function fail(ports: RestorePorts, reason: string): Promise<RestoreOutcome> {
  await ports.setJobState("FAILED", reason);
  return { ok: false, keyId: null, error: reason };
}
