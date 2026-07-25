// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  EngineDescriptorError,
  type DumpInput,
  type RestoreInput,
  type TargetConnection,
} from "../descriptor.js";
import { mariadbAdapter, mysqlAdapter } from "./mysql.js";

const CONN: TargetConnection = {
  host: "db.internal",
  port: 3306,
  database: "app",
  username: "backup",
  password: "s3cret",
  tls: true,
};

function dumpInput(over: Partial<DumpInput> = {}): DumpInput {
  return {
    connection: CONN,
    serverVersionNum: 80036,
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: ["app"], schemas: [], collections: [] },
    facts: { isReplicaSet: false, hasMyisam: false },
    ...over,
  };
}

describe("imageFor", () => {
  it("builds mysql:<maj.min> for the mysql family", () => {
    expect(mysqlAdapter.imageFor(80036)).toBe("mysql:8.0");
  });

  it("builds mariadb:<maj.min> for the mariadb family", () => {
    expect(mariadbAdapter.imageFor(110402)).toBe("mariadb:11.4");
  });
});

describe("mysqlAdapter.buildDump", () => {
  it("STREAM emits mysqldump --single-transaction to stdout", () => {
    const descriptor = mysqlAdapter.buildDump(dumpInput());
    expect(descriptor.command).toEqual([
      "mysqldump",
      "--single-transaction",
      "-h",
      "db.internal",
      "-P",
      "3306",
      "-u",
      "backup",
      "--ssl-mode=REQUIRED",
      "--databases",
      "app",
    ]);
    expect(descriptor.env.MYSQL_PWD).toBe("s3cret");
    expect(descriptor.outputKind).toBe("stdout");
  });

  it("STAGED emits mydumper to a directory with its own image", () => {
    const descriptor = mysqlAdapter.buildDump(
      dumpInput({ executionMode: "STAGED", parallelism: 4, stagingPath: "/scratch/out" }),
    );
    expect(descriptor.image).toBe("schrodump/mydumper:1");
    expect(descriptor.command).toEqual([
      "mydumper",
      "-h",
      "db.internal",
      "-P",
      "3306",
      "-u",
      "backup",
      "-B",
      "app",
      "-o",
      "/scratch/out",
      "-t",
      "4",
    ]);
    expect(descriptor.outputKind).toBe("directory");
  });

  it("returns a structured warning when MyISAM is in scope, never silencing it", () => {
    const descriptor = mysqlAdapter.buildDump(
      dumpInput({ facts: { isReplicaSet: false, hasMyisam: true } }),
    );
    expect(descriptor.warnings).toBeDefined();
    expect(descriptor.warnings?.[0]?.code).toBe("MYISAM_UNDER_SINGLE_TRANSACTION");
  });

  it("emits no warning when there is no MyISAM", () => {
    expect(mysqlAdapter.buildDump(dumpInput()).warnings).toBeUndefined();
  });

  it("refuses a STAGED dump without stagingPath", () => {
    expect(() => mysqlAdapter.buildDump(dumpInput({ executionMode: "STAGED" }))).toThrow(
      EngineDescriptorError,
    );
  });
});

describe("mariadbAdapter TLS flag", () => {
  it("uses --ssl for mariadb when TLS is on", () => {
    const descriptor = mariadbAdapter.buildDump(dumpInput({ serverVersionNum: 110402 }));
    expect(descriptor.command).toContain("--ssl");
  });
});

describe("buildRestore", () => {
  const restoreInput: RestoreInput = {
    connection: CONN,
    serverVersionNum: 80036,
    target: "DATABASE",
    scope: { databases: ["app"], schemas: [], collections: [] },
    executionMode: "STREAM",
  };
  const SOURCE_PATH = "/var/lib/schrodump/restore-source";

  it("STAGED restores via myloader from a directory, unchanged", () => {
    const descriptor = mysqlAdapter.buildRestore({
      ...restoreInput,
      executionMode: "STAGED",
      sourcePath: SOURCE_PATH,
    });
    expect(descriptor.image).toBe("schrodump/mydumper:1");
    expect(descriptor.command).toEqual([
      "myloader",
      "-h",
      "db.internal",
      "-P",
      "3306",
      "-u",
      "backup",
      "-B",
      "app",
      "-d",
      SOURCE_PATH,
    ]);
    expect(descriptor.env.MYSQL_PWD).toBe("s3cret");
    expect(descriptor.outputKind).toBe("directory");
  });

  // Fail-loud mechanism, verified against the real client images (see mysql.ts for the full
  // rationale): real MySQL 8's client has no --abort-source-on-error (a MariaDB-only extension
  // of the interactive `source` command), so this shared mysql/mariadb adapter can't rely on it.
  // Instead the client reads the mounted dump on stdin under `sh -c`; in that batch/non-
  // interactive mode both clients abort on the first SQL error by default (--force, default off,
  // is what would suppress that).
  it("STREAM execs mysql under sh -c, redirecting the mounted dump on stdin, no password on argv", () => {
    const descriptor = mysqlAdapter.buildRestore({
      ...restoreInput,
      executionMode: "STREAM",
      sourcePath: SOURCE_PATH,
    });
    expect(descriptor.command).toEqual([
      "sh",
      "-c",
      "exec 'mysql' '-h' 'db.internal' '-P' '3306' '-u' 'backup' '--ssl-mode=REQUIRED' 'app' < " +
        `'${SOURCE_PATH}'`,
    ]);
    expect(descriptor.env.MYSQL_PWD).toBe("s3cret");
    expect(descriptor.command.join(" ")).not.toContain("s3cret");
    expect(descriptor.outputKind).toBe("directory");
  });

  // mariadb:11+ dropped the `mysql` compat symlink that mariadb:10.x still ships (verified:
  // `docker run --rm mariadb:11 which mysql` fails; `mariadb:10.11 which mysql` resolves to a
  // symlink -> mariadb). Hardcoding "mysql" here would make the restore fail outright (exit 127)
  // against every mariadb 11+ target, so the client binary is family-aware.
  it("STREAM execs mariadb (not mysql) for the mariadb family", () => {
    const descriptor = mariadbAdapter.buildRestore({
      ...restoreInput,
      serverVersionNum: 110402,
      executionMode: "STREAM",
      sourcePath: SOURCE_PATH,
    });
    expect(descriptor.command).toEqual([
      "sh",
      "-c",
      "exec 'mariadb' '-h' 'db.internal' '-P' '3306' '-u' 'backup' '--ssl' 'app' < " +
        `'${SOURCE_PATH}'`,
    ]);
  });

  it("shell-quotes a source path containing a single quote, without breaking the redirect", () => {
    const descriptor = mysqlAdapter.buildRestore({
      ...restoreInput,
      executionMode: "STREAM",
      sourcePath: "/tmp/it's-a-path",
    });
    const script = descriptor.command[2];
    expect(script).toContain("< '/tmp/it'\\''s-a-path'");
  });
});

describe("buildVerifySandbox", () => {
  it("describes a mysql sandbox that pre-creates the origin database, with TCP-forced readiness", () => {
    const s = mysqlAdapter.buildVerifySandbox!(80036, "pw", "shop");
    expect(s.image).toBe("mysql:8.0");
    expect(s.env.MYSQL_ROOT_PASSWORD).toBe("pw");
    expect(s.env.MYSQL_DATABASE).toBe("shop");
    // -h 127.0.0.1 forces mysqladmin ping to probe TCP, not the local unix socket: the mysql
    // entrypoint runs a socket-only bootstrap server before the real TCP-listening server starts
    // (same lesson as postgres's pg_isready -h 127.0.0.1 fix).
    expect(s.readinessCommand).toEqual(["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]);
    expect(s.port).toBe(3306);
    expect(s.username).toBe("root");
    expect(s.database).toBe("shop");
    expect(s.password).toBe("pw");
  });

  it("describes a mariadb sandbox using the mariadb:<maj.min> image", () => {
    const s = mariadbAdapter.buildVerifySandbox!(110402, "pw", "shop");
    expect(s.image).toBe("mariadb:11.4");
    expect(s.env.MYSQL_ROOT_PASSWORD).toBe("pw");
    expect(s.env.MYSQL_DATABASE).toBe("shop");
    expect(s.readinessCommand).toEqual(["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]);
    expect(s.port).toBe(3306);
    expect(s.username).toBe("root");
    expect(s.database).toBe("shop");
    expect(s.password).toBe("pw");
  });
});
