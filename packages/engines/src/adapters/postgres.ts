// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { EngineDescriptorError, type EngineAdapter, type TargetConnection, type VerifySandbox } from "../descriptor.js";

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
      // Without this, pg_restore ignores per-object errors and STILL exits 0 ("errors ignored on
      // restore: N"). The executor reads success from the exit code, so a dump that restored only
      // partially would report SUCCEEDED — a failed restore reporting ok, which the thesis forbids.
      // Safe with --clean --if-exists (the DROPs don't error on absent objects).
      "--exit-on-error",
      ...schemaArgs,
    ];
    if (input.sourcePath !== undefined) {
      command.push(input.sourcePath);
      return { image, command, env: connEnv(connection), outputKind: "directory" };
    }
    return { image, command, env: connEnv(connection), outputKind: "stdout" };
  },

  // globals.bin is plain SQL (pg_dumpall --globals-only), which pg_restore cannot read; restore it
  // with psql reading the script on stdin (-f -). Deliberately WITHOUT ON_ERROR_STOP: pg_dumpall
  // always emits `CREATE ROLE <bootstrap>` (e.g. postgres), and every real target — including a
  // freshly initdb'd cluster — already has that role, so a strict run would abort on the
  // always-expected "role already exists". Globals restore is best-effort by standard pg_dumpall
  // practice; the per-database restore (buildRestore, above) uses pg_restore --exit-on-error to fail
  // on real data errors. Run first so roles/tablespaces exist before the per-database restore.
  buildGlobalsRestore(input) {
    const connection = input.connection;
    const command = ["psql", ...connArgs(connection), "-d", connection.database, "-f"];
    if (input.sourcePath !== undefined) {
      // Read the globals SQL from the mounted dump file instead of stdin (the staged-file pipeline).
      command.push(input.sourcePath);
      return { image: this.imageFor(input.serverVersionNum), command, env: connEnv(connection), outputKind: "directory" };
    }
    // No sourcePath: read the script on stdin (`-f -`).
    command.push("-");
    return { image: this.imageFor(input.serverVersionNum), command, env: connEnv(connection), outputKind: "stdout" };
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

  // `database` (the artifact's origin db) is ignored: a -Fc dump is db-name-agnostic, so the
  // sandbox always restores into its own fixed "verify" db regardless of the origin name.
  buildVerifySandbox(serverVersionNum, password, _database): VerifySandbox {
    const username = "verify";
    const database = "verify";
    return {
      image: this.imageFor(serverVersionNum),
      env: {
        POSTGRES_USER: username,
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: database,
      },
      // -h/-p force pg_isready to probe TCP, not the local unix socket. The postgres image's
      // bootstrap sequence runs a temporary socket-only server for initdb/scripts before
      // stopping it and starting the real TCP-listening server; a bare `pg_isready` would hit
      // that temp server and report "ready" before the real server (and its TCP port) is up.
      readinessCommand: ["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", username, "-d", database],
      port: 5432,
      username,
      password,
      database,
    };
  },
};
