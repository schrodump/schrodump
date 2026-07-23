// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import {
  EngineDescriptorError,
  type EngineAdapter,
  type ExecutionDescriptor,
  type TargetConnection,
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

      // STREAM: mysqldump --single-transaction to stdout.
      const databaseArgs =
        input.scope.databases.length > 0
          ? ["--databases", ...input.scope.databases]
          : [connection.database];
      const descriptor: ExecutionDescriptor = {
        image: this.imageFor(input.serverVersionNum),
        command: [
          "mysqldump",
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
      if (input.sourcePath !== undefined) {
        // mydumper output → myloader from a directory.
        return {
          image: MYDUMPER_IMAGE,
          command: ["myloader", ...connArgs(connection), "-B", connection.database, "-d", input.sourcePath],
          env: connEnv(connection),
          outputKind: "directory",
        };
      }
      // mysqldump output → mysql client reading the stream on stdin.
      return {
        image: this.imageFor(input.serverVersionNum),
        command: ["mysql", ...connArgs(connection), connection.database],
        env: connEnv(connection),
        outputKind: "stdout",
      };
    },

    buildVerifyAssertions(input) {
      const connection = input.connection;
      // Connect to the restored database and count its tables; DATABASE() avoids interpolating
      // the identifier into the SQL text.
      return {
        image: this.imageFor(input.serverVersionNum),
        command: [
          "mysql",
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
  };
}

export const mysqlAdapter = createSqlFamilyAdapter("mysql");
export const mariadbAdapter = createSqlFamilyAdapter("mariadb");
