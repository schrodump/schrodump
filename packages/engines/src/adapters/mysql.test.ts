// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { EngineDescriptorError, type DumpInput, type TargetConnection } from "../descriptor.js";
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
