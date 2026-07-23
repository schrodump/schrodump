// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { EngineDescriptorError, type DumpInput, type TargetConnection } from "../descriptor.js";
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
