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
  executionMode: "STREAM" | "STAGED";
  supportedRestoreTargets: RestoreTarget[];
  destinationName: string;
  // mongodb only: whether the archive was dumped with an oplog. undefined means unknown — either a
  // non-mongo engine, or an artifact written before the fact was recorded.
  sourceHasOplog?: boolean;
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

    // 0. The staged-file executor mounts the decrypted dump as a SINGLE FILE, which only fits a
    //    STREAM (single-stream) artifact — a STAGED (directory) artifact, of ANY engine including
    //    postgres, needs a separate untar-to-directory pipeline that does not exist in v1. Refuse
    //    loudly rather than let it reach the single-file pipeline and fail confusingly. Follow-up:
    //    a staged-directory restore pipeline, tracked separately.
    if (artifact.executionMode !== "STREAM") {
      return await fail(ports, "STAGED restore is not available in v1 (STREAM artifacts only)");
    }

    // 1. Validate the target against the capability matrix — a single-table restore of an artifact
    //    that lacks that granularity is a clear error, not a partial attempt.
    if (!artifact.supportedRestoreTargets.includes(req.target)) {
      return await fail(
        ports,
        `restore target ${req.target} is not supported for ${artifact.engine} artifacts`,
      );
    }

    // 2. Resolve the decryption key from the manifest's keyIds (retired keys included), never from
    //    global config.
    const keyId = resolveDecryptionKeyId(artifact.manifestKeyIds, await ports.availableKeys());
    if (keyId === null) {
      return await fail(
        ports,
        "no server-held identity matches this artifact (sealed) — supply an identity in memory",
      );
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
    // 5. A mongo FULL_CLUSTER restore of an archive whose provenance we never recorded runs without
    //    --oplogReplay, because emitting it against an archive that has no oplog crashes the whole
    //    restore. The restore still happens — refusing it would strand the operator mid-incident —
    //    but the cost is written down rather than swallowed: without replay, each collection lands
    //    at a slightly different effective timestamp. Each stays internally consistent; they just do
    //    not share one dump-end instant. Only "unknown" degrades: a recorded true was replayed, and
    //    a recorded false never had an oplog to replay.
    const degraded =
      ok &&
      artifact.engine === "mongodb" &&
      req.target === "FULL_CLUSTER" &&
      artifact.sourceHasOplog === undefined
        ? "restored without oplog replay: this artifact predates oplog tracking, so its collections may not share a single point in time"
        : undefined;
    await ports.setJobState(ok ? "SUCCEEDED" : "FAILED", degraded);
    return { ok, keyId, error: ok ? null : "restore failed" };
  } catch (error) {
    return await fail(ports, error instanceof Error ? error.message : "restore error");
  }
}

async function fail(ports: RestorePorts, reason: string): Promise<RestoreOutcome> {
  await ports.setJobState("FAILED", reason);
  return { ok: false, keyId: null, error: reason };
}
