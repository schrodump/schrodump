// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { EngineDescriptorError, type EngineAdapter, type TargetConnection } from "../descriptor.js";

const MIN_MAJOR = 13;
const MAX_MAJOR = 18;

function majorOf(serverVersionNum: number): number {
  return Math.floor(serverVersionNum / 10000);
}

// Non-secret connection args only. The password never appears here — it goes via env.
function connArgs(connection: TargetConnection): string[] {
  return ["-h", connection.host, "-p", String(connection.port), "-U", connection.username];
}

function connEnv(connection: TargetConnection): Record<string, string> {
  return {
    PGPASSWORD: connection.password,
    PGSSLMODE: connection.tls ? "require" : "disable",
  };
}

export const postgresAdapter: EngineAdapter = {
  kind: "postgres",

  imageFor(serverVersionNum) {
    const major = majorOf(serverVersionNum);
    if (major < MIN_MAJOR || major > MAX_MAJOR) {
      throw new EngineDescriptorError(
        "POSTGRES_UNSUPPORTED_VERSION",
        `postgres major ${major} is outside the supported range ${MIN_MAJOR}-${MAX_MAJOR}`,
      );
    }
    // pg_dump must be >= the server version; using the server's own major satisfies that.
    return `postgres:${major}-alpine`;
  },

  buildDump(input) {
    const image = this.imageFor(input.serverVersionNum);
    const connection = input.connection;
    const schemaArgs = input.scope.schemas.flatMap((schema) => ["-n", schema]);

    if (input.executionMode === "STAGED") {
      if (input.stagingPath === undefined) {
        throw new EngineDescriptorError(
          "POSTGRES_STAGING_PATH_REQUIRED",
          "a STAGED postgres dump requires stagingPath",
        );
      }
      // directory format (-Fd -j N) is the only parallel path and writes to a directory.
      return {
        image,
        command: [
          "pg_dump",
          ...connArgs(connection),
          "-d",
          connection.database,
          "-Fd",
          "-j",
          String(input.parallelism),
          "-f",
          input.stagingPath,
          ...schemaArgs,
        ],
        env: connEnv(connection),
        outputKind: "directory",
        workdir: input.stagingPath,
      };
    }

    // STREAM: custom format to stdout, single-threaded.
    return {
      image,
      command: ["pg_dump", ...connArgs(connection), "-d", connection.database, "-Fc", ...schemaArgs],
      env: connEnv(connection),
      outputKind: "stdout",
    };
  },

  // pg_dump excludes roles and tablespaces; a restore without globals fails on a missing role.
  // This is a descriptor separate from the per-database dump (requiresSeparateGlobalsDump).
  buildGlobalsDump(input) {
    const connection = input.connection;
    return {
      image: this.imageFor(input.serverVersionNum),
      command: ["pg_dumpall", ...connArgs(connection), "--globals-only"],
      env: connEnv(connection),
      outputKind: "stdout",
    };
  },

  buildRestore(input) {
    const image = this.imageFor(input.serverVersionNum);
    const connection = input.connection;
    const schemaArgs =
      input.target === "SCHEMA" ? input.scope.schemas.flatMap((schema) => ["-n", schema]) : [];
    const command = [
      "pg_restore",
      ...connArgs(connection),
      "-d",
      connection.database,
      "--clean",
      "--if-exists",
      ...schemaArgs,
    ];
    if (input.sourcePath !== undefined) {
      command.push(input.sourcePath);
      return { image, command, env: connEnv(connection), outputKind: "directory" };
    }
    return { image, command, env: connEnv(connection), outputKind: "stdout" };
  },

  buildVerifyAssertions(input) {
    const connection = input.connection;
    // Minimal restore verification: connect and count the restored user tables. ON_ERROR_STOP
    // turns any failure into a non-zero exit.
    return {
      image: this.imageFor(input.serverVersionNum),
      command: [
        "psql",
        ...connArgs(connection),
        "-d",
        connection.database,
        "-v",
        "ON_ERROR_STOP=1",
        "-tAc",
        "SELECT count(*) FROM information_schema.tables " +
          "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
      ],
      env: connEnv(connection),
      outputKind: "stdout",
    };
  },
};
