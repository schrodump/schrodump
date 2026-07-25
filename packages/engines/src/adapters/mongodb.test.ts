// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { EngineDescriptorError, type DumpInput, type RestoreInput, type TargetConnection } from "../descriptor.js";
import { mongodbAdapter } from "./mongodb.js";

const CONN: TargetConnection = {
  host: "db.internal",
  port: 27017,
  database: "app",
  username: "backup",
  password: "s3cret",
  tls: true,
};

function dumpInput(over: Partial<DumpInput> = {}): DumpInput {
  return {
    connection: CONN,
    serverVersionNum: 80004,
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: [], schemas: [], collections: [] },
    facts: { isReplicaSet: false, hasMyisam: false },
    ...over,
  };
}

function restoreInput(over: Partial<RestoreInput> = {}): RestoreInput {
  return {
    connection: CONN,
    serverVersionNum: 80004,
    target: "DATABASE",
    scope: { databases: [], schemas: [], collections: [] },
    executionMode: "STREAM",
    ...over,
  };
}

describe("mongodbAdapter.imageFor", () => {
  it("uses the official mongo:<major> image (which ships the tools)", () => {
    expect(mongodbAdapter.imageFor(80004)).toBe("mongo:8");
    expect(mongodbAdapter.imageFor(70005)).toBe("mongo:7");
  });
});

describe("mongodbAdapter.buildDump", () => {
  it("STREAM emits mongodump --archive to stdout, no oplog on a standalone", () => {
    const descriptor = mongodbAdapter.buildDump(dumpInput());
    expect(descriptor.command).toContain("mongodump");
    expect(descriptor.command).toContain("--archive");
    expect(descriptor.command).not.toContain("--oplog");
    expect(descriptor.outputKind).toBe("stdout");
  });

  it("adds --oplog for a full dump of a replica set", () => {
    const descriptor = mongodbAdapter.buildDump(
      dumpInput({ facts: { isReplicaSet: true, hasMyisam: false } }),
    );
    expect(descriptor.command).toContain("--oplog");
  });

  it("refuses a scoped dump on a replica set instead of only warning", () => {
    expect(() =>
      mongodbAdapter.buildDump(
        dumpInput({
          facts: { isReplicaSet: true, hasMyisam: false },
          scope: { databases: ["app"], schemas: [], collections: [] },
        }),
      ),
    ).toThrow(EngineDescriptorError);
  });

  it("keeps the password in env, never in the command", () => {
    const descriptor = mongodbAdapter.buildDump(dumpInput());
    for (const arg of descriptor.command) {
      expect(arg).not.toContain("s3cret");
    }
    expect(descriptor.command).toContain("--config");
    expect(descriptor.env.MONGODB_PASSWORD).toBe("s3cret");
  });
});

describe("mongodbAdapter.buildRestore", () => {
  it("STREAM reads from a mounted archive file with --drop, no --oplogReplay for DATABASE target", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        target: "DATABASE",
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).toContain("mongorestore");
    expect(descriptor.command).toContain("--archive=/var/lib/schrodump/restore-source");
    expect(descriptor.command).toContain("--drop");
    expect(descriptor.command).toContain("--config");
    expect(descriptor.command).not.toContain("--oplogReplay");
    expect(descriptor.outputKind).toBe("directory");
  });

  it("includes --oplogReplay only for FULL_CLUSTER target", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        target: "FULL_CLUSTER",
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).toContain("--oplogReplay");
  });

  it("includes --tls when connection.tls is true", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        connection: { ...CONN, tls: true },
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).toContain("--tls");
  });

  it("omits --tls when connection.tls is false", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        connection: { ...CONN, tls: false },
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).not.toContain("--tls");
  });

  it("keeps the password in env, never in the command", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    for (const arg of descriptor.command) {
      expect(arg).not.toContain("s3cret");
    }
    expect(descriptor.command).toContain("--config");
    expect(descriptor.env.MONGODB_PASSWORD).toBe("s3cret");
  });
});

describe("mongodbAdapter.buildVerifySandbox", () => {
  it("describes a mongo sandbox bootstrapped with a root user, forcing TCP readiness", () => {
    const s = mongodbAdapter.buildVerifySandbox!(80000, "pw", "shop");
    expect(s.image).toBe("mongo:8");
    expect(s.env.MONGO_INITDB_ROOT_USERNAME).toBe("verify");
    expect(s.env.MONGO_INITDB_ROOT_PASSWORD).toBe("pw");
    // --host 127.0.0.1 forces mongosh to probe TCP rather than whatever mongosh would otherwise
    // default to, the same defensive lesson as postgres's pg_isready -h 127.0.0.1 and mysql's
    // mysqladmin ping -h 127.0.0.1 (see postgres.ts / mysql.ts buildVerifySandbox).
    expect(s.readinessCommand).toEqual([
      "mongosh",
      "--host",
      "127.0.0.1",
      "--quiet",
      "--eval",
      "db.runCommand({ping:1}).ok",
    ]);
    expect(s.port).toBe(27017);
    expect(s.username).toBe("verify");
    expect(s.password).toBe("pw");
    expect(s.database).toBe("shop");
  });
});

describe("mongodbAdapter.buildVerifyAssertions", () => {
  it("never interpolates target-controlled values into the mongosh eval script", () => {
    const evil = 'evil"+process.exit(1)+"';
    const descriptor = mongodbAdapter.buildVerifyAssertions({
      connection: { ...CONN, host: evil, database: evil, username: evil },
      serverVersionNum: 80004,
      scope: { databases: [evil], schemas: [], collections: [] },
    });
    const script = descriptor.command.at(-1) ?? "";
    // The eval string is static; the malicious values live only in env.
    expect(script).not.toContain(evil);
    expect(script).not.toContain("process.exit");
    expect(descriptor.env.SCHRODUMP_MONGO_HOSTPORT).toContain(evil);
    for (const arg of descriptor.command) {
      expect(arg).not.toContain("s3cret");
    }
  });
});
