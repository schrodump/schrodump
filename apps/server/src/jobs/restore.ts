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
  // mysql/mariadb only: whether the dump script carries more than one database (mysqldump
  // --databases with two or more names). undefined means unknown — either an engine whose restore
  // is not a replayed script, or an artifact written before the fact was recorded.
  dumpIsMultiDatabase?: boolean;
}

// Engines whose restore replays a SQL script the dump wrote, rather than handing an archive to a
// tool that can filter it. Their buildRestore emits NO scoping flag, so the script's own USE
// statements decide where the writes land — there is no per-engine equivalent of pg_restore's -t or
// mongorestore's --nsInclude to confine them with.
const SCRIPT_RESTORE_ENGINES = ["mysql", "mariadb"];

// The producer side of `ArtifactForRestore.dumpIsMultiDatabase`, kept in the same file as the gate
// that reads it so the two cannot drift: a rule stated in one place and applied in another is how
// the capability matrix came to advertise a TABLE restore no adapter could perform.
//
// Recorded at dump time because it describes the ARTIFACT, not the origin — the origin's set of
// databases changes, and re-deriving the fact later would answer a question about today's server
// rather than about the script in the bucket.
export function dumpIsMultiDatabaseFor(
  engine: string,
  executionMode: "STREAM" | "STAGED",
  scopeDatabases: readonly string[],
): boolean | undefined {
  if (!SCRIPT_RESTORE_ENGINES.includes(engine)) return undefined;
  // STAGED is mydumper, and `mydumper -B <db>` dumps ONE database — myloader replays it into one
  // with the same flag. A staged artifact is single-database by construction, whatever the dump
  // scope listed, so it keeps the DATABASE restore that genuinely works for it.
  if (executionMode === "STAGED") return false;
  // STREAM is mysqldump: `--databases a b` is what puts CREATE DATABASE / USE / DROP TABLE for
  // more than one database into the script. One name (or none) cannot.
  return scopeDatabases.length >= 2;
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
      return await fail(
        ports,
        `restore target ${req.target} is not supported for ${artifact.engine} artifacts`,
      );
    }

    // 2. A script-restore artifact carrying more than one database cannot be restored INTO one of
    //    them. For these engines DATABASE and FULL_CLUSTER build the identical command, so the
    //    narrower target is a claim with no mechanism behind it: the script's CREATE DATABASE / USE
    //    / DROP TABLE run for every database it was dumped with. Measured on mysql 8.4.10 — two
    //    databases dumped together, the script restored "into" the first, and the second lost a row
    //    with the client exiting 0. Refusing costs the label, not the capability: FULL_CLUSTER runs
    //    the same command and says what it actually does.
    //
    //    Only a recorded `false` clears this gate. `undefined` is a WEAKER claim than false, and
    //    the failure direction decides how to treat it — permitting the hazard silently costs a
    //    neighbouring database, while refusing costs a word. Unlike oplog provenance this fact is
    //    recoverable without re-probing an origin that may be gone: the manifest in the bucket
    //    already carries the dump scope, so a catalog rebuild fills it in.
    if (SCRIPT_RESTORE_ENGINES.includes(artifact.engine) && req.target !== "FULL_CLUSTER") {
      if (artifact.dumpIsMultiDatabase === true) {
        return await fail(
          ports,
          `a ${req.target} restore of this ${artifact.engine} artifact cannot be confined: its dump ` +
            `script carries more than one database and would rewrite every one of them — restore it ` +
            `as FULL_CLUSTER if that is what you intend`,
        );
      }
      if (artifact.dumpIsMultiDatabase === undefined) {
        return await fail(
          ports,
          `whether this ${artifact.engine} artifact's dump script carries more than one database was ` +
            `never recorded, so a ${req.target} restore cannot be proven safe — restore it as ` +
            `FULL_CLUSTER, or rebuild the catalog to recover the fact from the manifest`,
        );
      }
    }

    // 3. Resolve the decryption key from the manifest's keyIds (retired keys included), never from
    //    global config.
    const keyId = resolveDecryptionKeyId(artifact.manifestKeyIds, await ports.availableKeys());
    if (keyId === null) {
      return await fail(
        ports,
        "no server-held identity matches this artifact (sealed) — supply an identity in memory",
      );
    }

    // 4. Restore over existing data requires explicit confirmation.
    if ((await ports.targetHasExistingData()) && !req.confirmExistingDatabase) {
      return await fail(ports, "restore over an existing database requires explicit confirmation");
    }

    // 5. Audit the restore, then execute.
    await ports.audit({
      action: "restore.execute",
      artifactId: req.artifactId,
      userId: req.userId,
      destinationName: artifact.destinationName,
      keyId,
    });
    const ok = await ports.runRestore(keyId);
    // 6. A mongo FULL_CLUSTER restore of an archive whose provenance we never recorded runs without
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
