// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { EngineDescriptorError, type DumpInput, type TargetConnection } from "../descriptor.js";
import { postgresAdapter } from "./postgres.js";

const CONN: TargetConnection = {
  host: "db.internal",
  port: 5432,
  database: "app",
  username: "backup",
  password: "s3cret",
  tls: true,
};

function dumpInput(over: Partial<DumpInput> = {}): DumpInput {
  return {
    connection: CONN,
    serverVersionNum: 160002,
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: ["app"], schemas: [], collections: [] },
    facts: { isReplicaSet: false, hasMyisam: false },
    ...over,
  };
}

describe("postgresAdapter.imageFor", () => {
  it("maps the server version to postgres:<major>-alpine", () => {
    expect(postgresAdapter.imageFor(160002)).toBe("postgres:16-alpine");
    expect(postgresAdapter.imageFor(130000)).toBe("postgres:13-alpine");
    expect(postgresAdapter.imageFor(180000)).toBe("postgres:18-alpine");
  });

  it("refuses versions outside the supported 13-18 range", () => {
    expect(() => postgresAdapter.imageFor(120500)).toThrow(EngineDescriptorError);
    expect(() => postgresAdapter.imageFor(190000)).toThrow(EngineDescriptorError);
  });
});

describe("postgresAdapter.buildDump", () => {
  it("STREAM emits pg_dump -Fc to stdout", () => {
    const descriptor = postgresAdapter.buildDump(dumpInput());
    expect(descriptor.command).toEqual([
      "pg_dump",
      "-h",
      "db.internal",
      "-p",
      "5432",
      "-U",
      "backup",
      "-d",
      "app",
      "-Fc",
    ]);
    expect(descriptor.outputKind).toBe("stdout");
    expect(descriptor.env.PGPASSWORD).toBe("s3cret");
    expect(descriptor.env.PGSSLMODE).toBe("require");
  });

  it("STAGED emits pg_dump -Fd -j N -f <path> writing a directory", () => {
    const descriptor = postgresAdapter.buildDump(
      dumpInput({ executionMode: "STAGED", parallelism: 4, stagingPath: "/scratch/out" }),
    );
    expect(descriptor.command).toEqual([
      "pg_dump",
      "-h",
      "db.internal",
      "-p",
      "5432",
      "-U",
      "backup",
      "-d",
      "app",
      "-Fd",
      "-j",
      "4",
      "-f",
      "/scratch/out",
    ]);
    expect(descriptor.outputKind).toBe("directory");
    expect(descriptor.workdir).toBe("/scratch/out");
  });

  it("adds -n for each scoped schema", () => {
    const descriptor = postgresAdapter.buildDump(
      dumpInput({ scope: { databases: ["app"], schemas: ["public", "audit"], collections: [] } }),
    );
    expect(descriptor.command.filter((arg) => arg === "-n")).toHaveLength(2);
    expect(descriptor.command).toContain("public");
    expect(descriptor.command).toContain("audit");
  });

  it("refuses a STAGED dump without stagingPath", () => {
    expect(() => postgresAdapter.buildDump(dumpInput({ executionMode: "STAGED" }))).toThrow(
      EngineDescriptorError,
    );
  });

  it("records PGSSLMODE=disable only as an explicit opt-out", () => {
    const descriptor = postgresAdapter.buildDump(dumpInput({ connection: { ...CONN, tls: false } }));
    expect(descriptor.env.PGSSLMODE).toBe("disable");
  });
});

describe("postgresAdapter.buildGlobalsDump", () => {
  it("emits pg_dumpall --globals-only as a separate descriptor", () => {
    const descriptor = postgresAdapter.buildGlobalsDump?.(dumpInput());
    expect(descriptor?.command).toEqual([
      "pg_dumpall",
      "-h",
      "db.internal",
      "-p",
      "5432",
      "-U",
      "backup",
      "--globals-only",
    ]);
    expect(descriptor?.outputKind).toBe("stdout");
  });
});
