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

// The password is delivered through this mounted config file (apps/server materializes it as a 0644
// file inside a 0700 scratch dir — see crypto/mongo-config.ts for why world-read is both required by
// the non-owner executor uid and safe — and bind-mounts it here); it never reaches argv.
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
    // --oplogReplay replays the archive's oplog so every collection lands on ONE instant. Emitted
    // only when both hold:
    //   sourceHasOplog === true — mongorestore hard-refuses the flag against an archive without an
    //     oplog ("no oplog file to replay"), crashing the whole restore. `undefined` (an artifact
    //     older than the fact) is deliberately NOT treated as true: the caller records the
    //     consistency caveat on the job instead of gambling a restore during an incident.
    //   target === FULL_CLUSTER — the oplog applies across the WHOLE archive, so replaying it into a
    //     DATABASE/COLLECTION target would write outside the scope that was asked for. (Same
    //     territory as the --drop warning below; both want --nsInclude when sub-scope restore lands.)
    // Without replay each collection ends at a slightly different effective timestamp — internally
    // consistent, but not sharing one dump-end instant.
    const oplogArgs =
      input.sourceHasOplog === true && input.target === "FULL_CLUSTER" ? ["--oplogReplay"] : [];

    // Namespace scoping, and the reason --drop below is safe to keep. mongorestore's --drop drops
    // the collections it is about to restore; with --nsInclude that set is exactly the requested
    // scope, and without it the set is the WHOLE archive. So the two are one decision, not two
    // flags: a sub-scope restore that emitted --drop with no --nsInclude would drop every namespace
    // in the archive to write one of them back. That is why this capability was withdrawn, and
    // scoping is what brings it back.
    //
    // FULL_CLUSTER stays unscoped on purpose — there the archive IS the scope.
    const nsArgs: string[] = [];
    if (input.target !== "FULL_CLUSTER") {
      const databases = input.scope.databases;
      // Refusing beats guessing. A sub-scope request with nothing to scope by has no safe
      // interpretation: the only one available would be "everything", which is the opposite of
      // what was asked for and destroys data outside it.
      if (databases.length === 0) {
        throw new EngineDescriptorError(
          "MONGODB_RESTORE_SCOPE_REQUIRED",
          "a DATABASE or COLLECTION restore must name at least one database to scope by; without it " +
            "--drop would reach every namespace in the archive",
        );
      }
      if (input.target === "COLLECTION") {
        if (databases.length !== 1) {
          throw new EngineDescriptorError(
            "MONGODB_RESTORE_COLLECTION_AMBIGUOUS",
            "a COLLECTION restore must name exactly one database, so each collection has an " +
              "unambiguous namespace",
          );
        }
        if (input.scope.collections.length === 0) {
          throw new EngineDescriptorError(
            "MONGODB_RESTORE_COLLECTION_REQUIRED",
            "a COLLECTION restore must name at least one collection",
          );
        }
        const database = databases[0] as string;
        for (const collection of input.scope.collections) {
          nsArgs.push(`--nsInclude=${database}.${collection}`);
        }
      } else {
        for (const database of databases) nsArgs.push(`--nsInclude=${database}.*`);
      }
    }

    const command = [
      "mongorestore",
      ...mongoConnArgs(connection),
      "--config",
      MONGO_CONFIG_PATH,
      ...(connection.tls ? ["--tls"] : []),
      // --drop drops the collections mongorestore is about to restore. Scoped by the --nsInclude
      // args above, so a DATABASE or COLLECTION restore drops only inside the requested namespace;
      // unscoped for FULL_CLUSTER, where the archive is the scope. Never emit one without the
      // other for a sub-scope target — see the block above.
      "--drop",
      ...nsArgs,
      ...oplogArgs,
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
      // --nodb is REQUIRED: without it mongosh opens an implicit default connection to
      // mongodb://127.0.0.1:27017 at startup — BEFORE running --eval — and aborts the whole session
      // with `MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017` (there is no mongod in this
      // one-shot client container), so the script's own `new Mongo(uri)` never runs. --nodb starts
      // mongosh with no default connection; the script makes the only connection, to the sandbox.
      command: ["mongosh", "--nodb", "--quiet", "--eval", script],
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
