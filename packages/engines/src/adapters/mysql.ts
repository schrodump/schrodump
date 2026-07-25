// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import {
  EngineDescriptorError,
  type EngineAdapter,
  type ExecutionDescriptor,
  type TargetConnection,
  type VerifySandbox,
} from "../descriptor.js";

// mydumper is not shipped in the official mysql/mariadb images; the parallel staged path uses
// a dedicated executor image.
const MYDUMPER_IMAGE = "schrodump/mydumper:1";

type SqlFamily = "mysql" | "mariadb";

// Non-secret connection args only. The password goes via MYSQL_PWD, never `-p` on argv.
function connArgs(connection: TargetConnection): string[] {
  return ["-h", connection.host, "-P", String(connection.port), "-u", connection.username];
}

function connEnv(connection: TargetConnection): Record<string, string> {
  return { MYSQL_PWD: connection.password };
}

function tlsArgs(family: SqlFamily, tls: boolean): string[] {
  if (family === "mariadb") return tls ? ["--ssl"] : [];
  return [tls ? "--ssl-mode=REQUIRED" : "--ssl-mode=DISABLED"];
}

// mariadb:11+ dropped the `mysql`/`mysqldump` -> mariadb compat symlinks that mariadb:10.x still
// ships (verified: `docker run --rm mariadb:11 which mariadb-dump mariadb` resolves to
// /usr/bin/mariadb-dump and /usr/bin/mariadb, while `mysqldump`/`mysql` are ABSENT; mariadb:10.11
// still resolves `mysql`/`mysqldump` via symlinks -> mariadb/mariadb-dump). The mysql family never
// ships the `mariadb*` names either way. So EVERY client invocation — dump (buildDump), restore
// (buildRestore) and the verify assertion (buildVerifyAssertions) — must select the family-correct
// binary, or it exits 127 against a mariadb 11+ target (which the capability matrix advertises).
function clientBinary(family: SqlFamily): string {
  return family === "mariadb" ? "mariadb" : "mysql";
}

function dumpBinary(family: SqlFamily): string {
  return family === "mariadb" ? "mariadb-dump" : "mysqldump";
}

// Single-quote a value for safe interpolation into a POSIX shell command string: close the
// quote, emit an escaped literal quote, reopen. Used only for buildRestore's STREAM branch,
// where connection host/user/db and sourcePath (not secrets, but not compile-time constants
// either) must be interpolated into a `sh -c` script rather than passed as separate argv
// elements.
function shQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

// One implementation, two table entries: mysql and mariadb differ only in the image base and
// the TLS flag. Adding "mariadb separado" is a registry entry, not a new branch.
function createSqlFamilyAdapter(family: SqlFamily): EngineAdapter {
  const imageBase = family;

  return {
    kind: family,

    imageFor(serverVersionNum) {
      const major = Math.floor(serverVersionNum / 10000);
      const minor = Math.floor((serverVersionNum % 10000) / 100);
      return `${imageBase}:${major}.${minor}`;
    },

    buildDump(input) {
      const connection = input.connection;

      if (input.executionMode === "STAGED") {
        if (input.stagingPath === undefined) {
          throw new EngineDescriptorError(
            "MYSQL_STAGING_PATH_REQUIRED",
            "a STAGED mysql/mariadb dump requires stagingPath",
          );
        }
        return {
          image: MYDUMPER_IMAGE,
          command: [
            "mydumper",
            ...connArgs(connection),
            "-B",
            connection.database,
            "-o",
            input.stagingPath,
            "-t",
            String(input.parallelism),
          ],
          env: connEnv(connection),
          outputKind: "directory",
          workdir: input.stagingPath,
        };
      }

      // STREAM: mysqldump/mariadb-dump --single-transaction to stdout.
      const databaseArgs =
        input.scope.databases.length > 0
          ? ["--databases", ...input.scope.databases]
          : [connection.database];
      const descriptor: ExecutionDescriptor = {
        image: this.imageFor(input.serverVersionNum),
        command: [
          dumpBinary(family),
          "--single-transaction",
          ...connArgs(connection),
          ...tlsArgs(family, connection.tls),
          ...databaseArgs,
        ],
        env: connEnv(connection),
        outputKind: "stdout",
      };

      // --single-transaction only guarantees consistency for InnoDB. Surface MyISAM instead of
      // silently producing an inconsistent dump; the alternative (--lock-tables) blocks writes
      // and must be an explicit user choice.
      if (input.facts.hasMyisam) {
        return {
          ...descriptor,
          warnings: [
            {
              code: "MYISAM_UNDER_SINGLE_TRANSACTION",
              message:
                "--single-transaction guarantees consistency only for InnoDB; MyISAM tables in " +
                "scope may be inconsistent. Choose --lock-tables explicitly to lock writes.",
            },
          ],
        };
      }
      return descriptor;
    },

    buildRestore(input) {
      const connection = input.connection;

      if (input.executionMode === "STAGED") {
        if (input.sourcePath === undefined) {
          throw new EngineDescriptorError(
            "MYSQL_RESTORE_SOURCE_PATH_REQUIRED",
            "a STAGED mysql/mariadb restore requires sourcePath",
          );
        }
        // mydumper output → myloader from a directory. Unreachable while STAGED restore is
        // gated in v1 (apps/server refuses non-STREAM artifacts); kept for when it ships.
        return {
          image: MYDUMPER_IMAGE,
          command: ["myloader", ...connArgs(connection), "-B", connection.database, "-d", input.sourcePath],
          env: connEnv(connection),
          outputKind: "directory",
        };
      }

      if (input.sourcePath === undefined) {
        throw new EngineDescriptorError(
          "MYSQL_RESTORE_SOURCE_PATH_REQUIRED",
          "a STREAM mysql/mariadb restore requires sourcePath",
        );
      }

      // STREAM: the artifact is a mysqldump SQL script mounted at sourcePath (restore always
      // stages the decrypted artifact to a file now — no stdin path; see e44e43e).
      //
      // FAIL-LOUD MECHANISM — verified against the real client images, not assumed:
      // `docker run --rm mysql:8 mysql --help 2>&1 | grep -i abort` finds nothing; MySQL 8.4.10's
      // client has no --abort-source-on-error flag at all. `docker run --rm mariadb:11 mariadb
      // --help 2>&1 | grep -i abort` finds `--abort-source-on-error` (a MariaDB-only extension of
      // the interactive `source filename` command). Because this flag is absent from the real
      // MySQL client and this adapter is shared by both families (one implementation, two table
      // entries), Option A (`-e "source <path>" --abort-source-on-error`) can't be the mechanism
      // here.
      //
      // Option B instead: run the client under `sh -c`, redirecting the mounted dump onto its
      // stdin. In that batch/non-interactive mode (as opposed to `-e "source ..."`) both `mysql`
      // and `mariadb` clients abort on the FIRST SQL error by default — confirmed in both
      // --help outputs: `-f, --force  Continue even if we get an SQL error` defaults to FALSE.
      // Without fail-loud, the client would run past a broken statement and the executor would
      // read a clean exit code from a partially-restored database — the exact hole postgres's
      // --exit-on-error closes (see postgres.ts buildRestore).
      //
      // Only non-secret values are interpolated into the shell string: host/port/user (connArgs),
      // the TLS flag, connection.database, and our own constant sourcePath — each single-quoted
      // (shQuote). The password is never in argv or the shell string; it stays in MYSQL_PWD (env).
      const shellArgs = [
        clientBinary(family),
        ...connArgs(connection),
        ...tlsArgs(family, connection.tls),
        connection.database,
      ];
      const shellCommand =
        "exec " + shellArgs.map(shQuote).join(" ") + " < " + shQuote(input.sourcePath);

      return {
        image: this.imageFor(input.serverVersionNum),
        command: ["sh", "-c", shellCommand],
        env: connEnv(connection),
        outputKind: "directory",
      };
    },

    buildVerifyAssertions(input) {
      const connection = input.connection;
      // Connect to the restored database and count its tables; DATABASE() avoids interpolating
      // the identifier into the SQL text. Family-aware binary (see clientBinary): mariadb 11+ has
      // no `mysql` client, so hardcoding it would exit 127 on the verify assertion.
      return {
        image: this.imageFor(input.serverVersionNum),
        command: [
          clientBinary(family),
          ...connArgs(connection),
          connection.database,
          "-N",
          "-e",
          "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()",
        ],
        env: connEnv(connection),
        outputKind: "stdout",
      };
    },

    // Unlike postgres (db-name-agnostic -Fc dump), a mysqldump restore runs `USE <origin>` / a
    // single-db dump has no CREATE DATABASE — the origin database must already exist. MYSQL_DATABASE
    // pre-creates it at bootstrap so the restore (buildRestore) has somewhere to land.
    buildVerifySandbox(serverVersionNum, password, database): VerifySandbox {
      const username = "root";
      return {
        image: this.imageFor(serverVersionNum),
        env: {
          MYSQL_ROOT_PASSWORD: password,
          MYSQL_DATABASE: database,
        },
        // -h 127.0.0.1 forces mysqladmin ping to probe TCP, not the local unix socket: the mysql
        // entrypoint runs a socket-only bootstrap server for its init scripts before stopping it
        // and starting the real TCP-listening server — same lesson as postgres's pg_isready -h
        // 127.0.0.1 fix (see postgres.ts buildVerifySandbox).
        readinessCommand: ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"],
        port: 3306,
        username,
        password,
        database,
      };
    },
  };
}

export const mysqlAdapter = createSqlFamilyAdapter("mysql");
export const mariadbAdapter = createSqlFamilyAdapter("mariadb");
