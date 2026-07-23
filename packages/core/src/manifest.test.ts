// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { parseManifest, serializeManifest, type Manifest } from "./manifest.js";

const VALID: Manifest = {
  manifestVersion: 1,
  jobId: "job-1",
  organizationId: "org-1",
  engine: "postgres",
  serverVersionNum: 160002,
  toolVersion: "pg_dump 16.2",
  executionMode: "STAGED",
  parallelism: 4,
  scope: { databases: ["app"], schemas: ["public"], collections: [] },
  sizeRawBytes: 1024,
  sizeCompressedBytes: 256,
  checksumAlgorithm: "sha256",
  checksum: "abc123",
  compression: "zstd",
  encryption: { algorithm: "age", keyIds: ["fp-operational", "fp-escrow"] },
  dependsOn: [],
  createdAt: "2026-07-23T10:00:00Z",
  durationMs: 5000,
};

describe("parseManifest / serializeManifest", () => {
  it("round-trips parse -> serialize -> parse", () => {
    const first = parseManifest(VALID);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const serialized = serializeManifest(first.manifest);
    const second = parseManifest(JSON.parse(serialized));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.manifest).toEqual(VALID);
  });

  it("serializes deterministically regardless of key order (top-level and nested)", () => {
    const reordered: Manifest = {
      durationMs: 5000,
      createdAt: "2026-07-23T10:00:00Z",
      dependsOn: [],
      encryption: { keyIds: ["fp-operational", "fp-escrow"], algorithm: "age" },
      compression: "zstd",
      checksum: "abc123",
      checksumAlgorithm: "sha256",
      sizeCompressedBytes: 256,
      sizeRawBytes: 1024,
      scope: { collections: [], schemas: ["public"], databases: ["app"] },
      parallelism: 4,
      executionMode: "STAGED",
      toolVersion: "pg_dump 16.2",
      serverVersionNum: 160002,
      engine: "postgres",
      organizationId: "org-1",
      jobId: "job-1",
      manifestVersion: 1,
    };

    expect(serializeManifest(reordered)).toBe(serializeManifest(VALID));
  });

  it("returns structured issues instead of throwing on invalid input", () => {
    const result = parseManifest({ manifestVersion: 2, jobId: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.issues.map((issue) => issue.path)).toContain("manifestVersion");
    for (const issue of result.error.issues) {
      expect(typeof issue.code).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
  });
});
