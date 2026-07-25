// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  EngineDescriptorError,
  type DumpInput,
  type RestoreInput,
  type TargetConnection,
} from "../descriptor.js";
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

describe("postgresAdapter.buildGlobalsRestore", () => {
  const restoreInput: RestoreInput = {
    connection: CONN,
    serverVersionNum: 160002,
    target: "FULL_CLUSTER",
    scope: { databases: ["app"], schemas: [], collections: [] },
    executionMode: "STREAM",
  };

  it("emits psql -f - reading the globals SQL on stdin, WITHOUT ON_ERROR_STOP", () => {
    // pg_dumpall always emits CREATE ROLE for the bootstrap role, which exists on every cluster;
    // ON_ERROR_STOP would make that always-expected conflict abort the restore. Globals restore is
    // best-effort (standard pg_dumpall practice) — the per-database restore keeps ON_ERROR_STOP.
    const descriptor = postgresAdapter.buildGlobalsRestore?.(restoreInput);
    expect(descriptor?.command).toEqual(["psql", "-h", "db.internal", "-p", "5432", "-U", "backup", "-d", "app", "-f", "-"]);
    expect(descriptor?.command).not.toContain("ON_ERROR_STOP=1");
    expect(descriptor?.env.PGPASSWORD).toBe("s3cret");
  });

  it("emits psql -f <sourcePath> reading the globals SQL from the mounted file, still WITHOUT ON_ERROR_STOP", () => {
    // The staged-file pipeline mounts the decrypted globals script and passes its path; psql reads
    // the file instead of stdin. The best-effort stance (no ON_ERROR_STOP) is unchanged.
    const descriptor = postgresAdapter.buildGlobalsRestore?.({
      ...restoreInput,
      sourcePath: "/var/lib/schrodump/restore-source",
    });
    expect(descriptor?.command).toEqual([
      "psql", "-h", "db.internal", "-p", "5432", "-U", "backup", "-d", "app",
      "-f", "/var/lib/schrodump/restore-source",
    ]);
    expect(descriptor?.command).not.toContain("-");
    expect(descriptor?.command).not.toContain("ON_ERROR_STOP=1");
    expect(descriptor?.env.PGPASSWORD).toBe("s3cret");
  });
});

describe("postgresAdapter.buildRestore", () => {
  const restoreInput: RestoreInput = {
    connection: CONN,
    serverVersionNum: 160002,
    target: "DATABASE",
    scope: { databases: ["app"], schemas: [], collections: [] },
    executionMode: "STREAM",
  };

  it("runs pg_restore --clean --if-exists --exit-on-error, reading the mounted dump as a file", () => {
    // --exit-on-error is load-bearing: without it pg_restore ignores per-object failures and STILL
    // exits 0, which the executor reads as SUCCEEDED — a partially-restored dump reporting ok, the
    // exact failure the thesis forbids. --clean --if-exists keeps the DROPs from erroring on absent
    // objects. The dump is a mounted positional file (sourcePath), never a second stdin.
    const descriptor = postgresAdapter.buildRestore({
      ...restoreInput,
      sourcePath: "/var/lib/schrodump/restore-source",
    });
    expect(descriptor.command).toEqual([
      "pg_restore", "-h", "db.internal", "-p", "5432", "-U", "backup", "-d", "app",
      "--clean", "--if-exists", "--exit-on-error", "/var/lib/schrodump/restore-source",
    ]);
    expect(descriptor.env.PGPASSWORD).toBe("s3cret");
  });
});

describe("postgresAdapter.buildVerifySandbox", () => {
  it("describes a postgres sandbox of the artifact's major with bootstrap creds and readiness, ignoring the origin database", () => {
    // A -Fc dump is db-name-agnostic (pg_restore -d can target any database), so postgres always
    // uses its fixed "verify" sandbox db regardless of what the artifact's origin database was.
    const s = postgresAdapter.buildVerifySandbox!(160002, "secret-123", "shop");
    expect(s.image).toBe("postgres:16-alpine");
    expect(s.env.POSTGRES_USER).toBe("verify");
    expect(s.env.POSTGRES_PASSWORD).toBe("secret-123");
    expect(s.env.POSTGRES_DB).toBe("verify");
    expect(s.readinessCommand).toEqual([
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      "verify",
      "-d",
      "verify",
    ]);
    expect(s.port).toBe(5432);
    expect(s.username).toBe("verify");
    expect(s.database).toBe("verify");
    expect(s.password).toBe("secret-123");
  });
});
