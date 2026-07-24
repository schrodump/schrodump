// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { toArtifactRecord } from "./wiring.js";

// A full Artifact row as Prisma returns it — sizes are BigInt, plus internal columns the API must
// not expose.
const row = {
  id: "a1",
  organizationId: "o1",
  jobId: "j1",
  destinationId: "d1",
  state: "UNOBSERVED",
  bucketKey: "org/backup.age",
  manifestKey: "org/backup.manifest.json",
  engine: "postgres",
  serverVersionNum: 160002,
  sizeRawBytes: 9_000_000_000n,
  sizeCompressedBytes: 1_500_000_000n,
  checksumAlgorithm: "sha256",
  checksum: "abc",
  compression: "zstd",
  keyIds: ["age1..."],
  dependsOn: [],
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-02T00:00:00.000Z"),
};

describe("toArtifactRecord", () => {
  it("converts BigInt sizes to number so Fastify can JSON-serialize the row", () => {
    const record = toArtifactRecord(row);
    expect(record.sizeRawBytes).toBe(9_000_000_000);
    expect(record.sizeCompressedBytes).toBe(1_500_000_000);
    expect(typeof record.sizeRawBytes).toBe("number");
    // The original bug: a raw BigInt reaching JSON.stringify throws (and Fastify 500s).
    expect(() => JSON.stringify(record)).not.toThrow();
  });

  it("does not leak internal columns", () => {
    const record = toArtifactRecord(row);
    expect("organizationId" in record).toBe(false);
    expect("updatedAt" in record).toBe(false);
  });
});
