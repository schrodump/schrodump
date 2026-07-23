// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { EngineDescriptorError, type EngineAdapter, type TargetConnection } from "../descriptor.js";

// The official mongo:<major> image ships mongodump/mongorestore (MongoDB Database Tools),
// verified empirically: `docker run --rm mongo:8 which mongodump` -> /usr/bin/mongodump.

// The password is delivered through this mounted config file (runner materializes
// env MONGODB_PASSWORD into it); it never reaches argv. mongodump/mongorestore load the
// password from `--config`.
const MONGO_CONFIG_PATH = "/etc/schrodump/mongodb.yaml";

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
    // --oplogReplay applies to a full-instance restore of an oplog-bearing archive.
    const oplogArgs = input.target === "FULL_CLUSTER" ? ["--oplogReplay"] : [];
    return {
      image: this.imageFor(input.serverVersionNum),
      command: [
        "mongorestore",
        ...mongoConnArgs(connection),
        "--config",
        MONGO_CONFIG_PATH,
        ...(connection.tls ? ["--tls"] : []),
        "--archive",
        ...oplogArgs,
      ],
      env: mongoEnv(connection),
      outputKind: "stdout",
    };
  },

  buildVerifyAssertions(input) {
    const connection = input.connection;
    const database = input.scope.databases[0] ?? connection.database;
    const tlsQuery = connection.tls ? "&tls=true" : "";
    // The password is read from process.env inside the eval, so only the env var NAME appears
    // in argv — never the value.
    const script = [
      `const user = ${JSON.stringify(connection.username)};`,
      `const pass = process.env.MONGODB_PASSWORD || "";`,
      `const uri = "mongodb://" + encodeURIComponent(user) + ":" + encodeURIComponent(pass) + ` +
        `"@${connection.host}:${connection.port}/?authSource=${connection.database}${tlsQuery}";`,
      `print(new Mongo(uri).getDB(${JSON.stringify(database)}).getCollectionNames().length);`,
    ].join(" ");

    return {
      image: this.imageFor(input.serverVersionNum),
      command: ["mongosh", "--quiet", "--eval", script],
      env: mongoEnv(connection),
      outputKind: "stdout",
    };
  },
};
