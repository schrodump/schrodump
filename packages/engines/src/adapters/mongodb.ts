// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import {
  EngineDescriptorError,
  type EngineAdapter,
  type TargetConnection,
  type VerifySandbox,
} from "../descriptor.js";

// The official mongo:<major> image ships mongodump/mongorestore (MongoDB Database Tools),
// verified empirically: `docker run --rm mongo:8 which mongodump` -> /usr/bin/mongodump.

// The password is delivered through this mounted config file (apps/server materializes it as a 0600
// scratch file — see crypto/mongo-config.ts — and bind-mounts it here); it never reaches argv.
// mongodump/mongorestore load the password from `--config`. Exported so the composer mounts THIS
// path rather than hardcoding it.
export const MONGO_CONFIG_PATH = "/etc/schrodump/mongodb.yaml";

function mongoConnArgs(connection: TargetConnection): string[] {
  return [
    "--host",
    connection.host,
    "--port",
    String(connection.port),
    "--username",
    connection.username,
    "--authenticationDatabase",
    connection.database,
  ];
}

function mongoEnv(connection: TargetConnection): Record<string, string> {
  return { MONGODB_PASSWORD: connection.password };
}

export const mongodbAdapter: EngineAdapter = {
  kind: "mongodb",

  imageFor(serverVersionNum) {
    const major = Math.floor(serverVersionNum / 10000);
    return `mongo:${major}`;
  },

  buildDump(input) {
    const connection = input.connection;
    const scoped = input.scope.databases.length > 0 || input.scope.collections.length > 0;

    // --oplog is mandatory on a replica set for a logically consistent snapshot, but it is
    // incompatible with a scoped (--db/--collection) dump. Refuse rather than emit an
    // inconsistent scoped dump — this is a hard error, not a warning.
    if (input.facts.isReplicaSet && scoped) {
      throw new EngineDescriptorError(
        "MONGODB_OPLOG_REQUIRES_FULL_DUMP",
        "a replica set requires --oplog for consistency, which is incompatible with a scoped " +
          "dump; dump the full instance instead of scoping databases/collections",
      );
    }
    if (input.scope.databases.length > 1 || input.scope.collections.length > 1) {
      throw new EngineDescriptorError(
        "MONGODB_SCOPE_TOO_BROAD",
        "mongodump handles at most one --db and one --collection per invocation",
      );
    }

    const scopeArgs: string[] = [];
    const database = input.scope.databases[0];
    if (database !== undefined) {
      scopeArgs.push("--db", database);
      const collection = input.scope.collections[0];
      if (collection !== undefined) scopeArgs.push("--collection", collection);
    }

    const oplogArgs = input.facts.isReplicaSet ? ["--oplog"] : [];

    return {
      image: this.imageFor(input.serverVersionNum),
      command: [
        "mongodump",
        ...mongoConnArgs(connection),
        "--config",
        MONGO_CONFIG_PATH,
        ...(connection.tls ? ["--tls"] : []),
        "--archive",
        ...oplogArgs,
        ...scopeArgs,
      ],
      env: mongoEnv(connection),
      outputKind: "stdout",
    };
  },

  buildRestore(input) {
    const connection = input.connection;
    // --oplogReplay is NEVER emitted, deliberately, even for a FULL_CLUSTER target. mongorestore
    // hard-refuses it ("no oplog file to replay") unless the SOURCE archive was dumped with
    // --oplog, and RestoreInput carries no fact telling this builder whether it was — buildDump's
    // own choice (facts.isReplicaSet) is not threaded through to restore, in either the real
    // restore path or FULL_RESTORE verify's sandbox restore (which never re-probes the origin by
    // design). Guessing "yes" is a hard crash of the WHOLE restore for the guaranteed-common case
    // (buildDump refuses a scoped dump on a replica set, so any scoped mongo artifact — the only
    // kind FULL_RESTORE verify's sandbox ever restores, since resolveVerifyPlan downgrades
    // unscoped mongo to CHECKSUM — is provably never oplog-bearing); guessing "no" only means an
    // actual replica-set-sourced FULL_CLUSTER restore skips replaying that supplementary oplog
    // window, a data-consistency nuance, not a failure. Tracked in docs/roadmap.md.
    const command = [
      "mongorestore",
      ...mongoConnArgs(connection),
      "--config",
      MONGO_CONFIG_PATH,
      ...(connection.tls ? ["--tls"] : []),
      // --drop drops each collection in the ARCHIVE before restoring it (mongo's --clean). It is NOT
      // namespace-scoped: it never reads input.scope. Today the only caller is FULL_RESTORE verify,
      // which restores a full archive into a fresh throwaway sandbox — safe. WARNING: when sub-scope
      // restore (DATABASE/COLLECTION into a real, possibly-non-empty target) lands, --drop would drop
      // every namespace present in the archive, not just the scoped one — add --nsInclude scoping then.
      "--drop",
    ];

    if (input.sourcePath !== undefined) {
      command.push(`--archive=${input.sourcePath}`);
      return {
        image: this.imageFor(input.serverVersionNum),
        command,
        env: mongoEnv(connection),
        outputKind: "directory",
      };
    }

    command.push("--archive");
    return {
      image: this.imageFor(input.serverVersionNum),
      command,
      env: mongoEnv(connection),
      outputKind: "stdout",
    };
  },

  buildVerifyAssertions(input) {
    const connection = input.connection;
    const database = input.scope.databases[0] ?? connection.database;
    // STATIC eval script: every dynamic value is passed through env and read with process.env,
    // so no target-controlled string is ever interpolated into the JS that mongosh evaluates
    // (env values are data, never code). This closes the script-injection vector.
    const script =
      'const user = encodeURIComponent(process.env.SCHRODUMP_MONGO_USER || "");' +
      'const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || "");' +
      'const auth = encodeURIComponent(process.env.SCHRODUMP_MONGO_AUTHDB || "");' +
      'const tls = process.env.SCHRODUMP_MONGO_TLS === "1" ? "&tls=true" : "";' +
      'const uri = "mongodb://" + user + ":" + pass + "@" + process.env.SCHRODUMP_MONGO_HOSTPORT +' +
      ' "/?authSource=" + auth + tls;' +
      "print(new Mongo(uri).getDB(process.env.SCHRODUMP_MONGO_DB).getCollectionNames().length);";

    return {
      image: this.imageFor(input.serverVersionNum),
      command: ["mongosh", "--quiet", "--eval", script],
      env: {
        ...mongoEnv(connection),
        SCHRODUMP_MONGO_USER: connection.username,
        SCHRODUMP_MONGO_HOSTPORT: `${connection.host}:${connection.port}`,
        SCHRODUMP_MONGO_AUTHDB: connection.database,
        SCHRODUMP_MONGO_DB: database,
        SCHRODUMP_MONGO_TLS: connection.tls ? "1" : "0",
      },
      outputKind: "stdout",
    };
  },

  // Unlike postgres/mysql, the sandbox runs WITH auth: the official image bootstraps a root user
  // from MONGO_INITDB_ROOT_USERNAME/PASSWORD, which mongorestore (mongoConnArgs, above) needs to
  // authenticate. `database` is the artifact's origin db, passed through unchanged — it is NOT the
  // authSource the root user authenticates against (that's always "admin", where
  // MONGO_INITDB_ROOT_USERNAME is created). This adapter only DESCRIBES the sandbox; the caller
  // (worker-wiring) is responsible for building a TargetConnection whose `database`/authSource
  // matches "admin" for the mongo restore/verify commands, separately from the origin db this
  // sandbox reports (used e.g. to scope the verify assertion to the restored database).
  buildVerifySandbox(serverVersionNum, password, database): VerifySandbox {
    const username = "verify";
    return {
      image: this.imageFor(serverVersionNum),
      env: {
        MONGO_INITDB_ROOT_USERNAME: username,
        MONGO_INITDB_ROOT_PASSWORD: password,
      },
      // --host 127.0.0.1 forces mongosh to probe TCP explicitly rather than relying on mongosh's
      // own default resolution — the same defensive posture as postgres's pg_isready -h 127.0.0.1
      // and mysql's mysqladmin ping -h 127.0.0.1 (see postgres.ts / mysql.ts buildVerifySandbox).
      //
      // Unlike postgres/mysql, an unauthenticated ping is NOT enough here. Postgres's and mysql's
      // bootstrap temp servers are socket-only (no TCP), so forcing TCP alone already guarantees
      // the readiness probe only ever reaches the real server. Mongo's bootstrap sequence is
      // different: the *temporary* mongod that creates the root user ALSO binds TCP on
      // 127.0.0.1:27017, with --auth stripped — verified empirically against mongo:8. An
      // unauthenticated `ping` (pre-auth-allowed by MongoDB by design) succeeds against that temp
      // server in a few ms, well before the real, auth-enforcing server (with the root user) is
      // up — declaring the sandbox ready while mongorestore/verify then races a server that's
      // about to restart. Requiring auth as the `verify` root user (who only exists once the real
      // server is up, in `admin`) closes that race: the probe can only succeed against the real
      // server. The password is read from $MONGO_INITDB_ROOT_PASSWORD, expanded by the
      // container's own shell from the container's own env (set below) — it never appears on our
      // argv or in this command array.
      readinessCommand: [
        "sh",
        "-c",
        'exec mongosh -u verify -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin ' +
          "--host 127.0.0.1 --quiet --eval 'db.runCommand({ping:1}).ok'",
      ],
      port: 27017,
      username,
      password,
      database,
    };
  },
};
