// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { type Manifest } from "./manifest.js";
import { RetentionOrphanError, resolveRetention, type RetentionPolicy } from "./retention.js";

const NOW = new Date("2026-07-23T12:00:00Z");

function mf(jobId: string, createdAt: string, dependsOn: string[] = []): Manifest {
  return {
    manifestVersion: 1,
    jobId,
    organizationId: "org-1",
    engine: "postgres",
    serverVersionNum: 160002,
    toolVersion: "pg_dump 16.2",
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: ["app"], schemas: [], collections: [] },
    sizeRawBytes: 1,
    sizeCompressedBytes: 1,
    checksumAlgorithm: "sha256",
    checksum: "x",
    compression: "zstd",
    encryption: { algorithm: "age", keyIds: ["fp"] },
    dependsOn,
    createdAt,
    durationMs: 1,
  };
}

function policy(over: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    keepLast: 0,
    keepDaily: 0,
    keepWeekly: 0,
    keepMonthly: 0,
    keepYearly: 0,
    minAgeBeforeDelete: 0,
    ...over,
  };
}

describe("resolveRetention", () => {
  it("keepLast keeps the N most recent by createdAt", () => {
    const ms = [
      mf("a", "2026-07-20T00:00:00Z"),
      mf("b", "2026-07-21T00:00:00Z"),
      mf("c", "2026-07-22T00:00:00Z"),
    ];
    const result = resolveRetention(ms, policy({ keepLast: 2 }), NOW);
    expect(new Set(result.keep)).toEqual(new Set(["b", "c"]));
    expect(result.delete).toEqual(["a"]);
  });

  it("keepDaily keeps the newest backup of each of the last N days", () => {
    const ms = [
      mf("d1-early", "2026-07-21T01:00:00Z"),
      mf("d1-late", "2026-07-21T20:00:00Z"),
      mf("d2", "2026-07-22T10:00:00Z"),
      mf("d3", "2026-07-23T10:00:00Z"),
    ];
    const result = resolveRetention(ms, policy({ keepDaily: 2 }), NOW);
    expect(new Set(result.keep)).toEqual(new Set(["d3", "d2"]));
  });

  it("marks everything for deletion under an empty policy", () => {
    const ms = [mf("a", "2026-07-20T00:00:00Z"), mf("b", "2026-07-21T00:00:00Z")];
    const result = resolveRetention(ms, policy(), NOW);
    expect(result.keep).toEqual([]);
    expect(new Set(result.delete)).toEqual(new Set(["a", "b"]));
  });

  it("never deletes a manifest younger than minAgeBeforeDelete", () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const ms = [mf("recent", "2026-07-23T11:00:00Z"), mf("old", "2026-01-01T00:00:00Z")];
    const result = resolveRetention(ms, policy({ minAgeBeforeDelete: oneDayMs }), NOW);
    expect(result.keep).toContain("recent");
    expect(result.delete).toContain("old");
  });

  it("keeps the whole dependency chain together when the dependent is kept", () => {
    const full = mf("full", "2026-07-22T00:00:00Z");
    const inc = mf("inc", "2026-07-22T06:00:00Z", ["full"]);
    const result = resolveRetention([full, inc], policy({ keepLast: 2 }), NOW);
    expect(new Set(result.keep)).toEqual(new Set(["full", "inc"]));
    expect(result.delete).toEqual([]);
  });

  it("throws instead of deleting a full that a kept incremental depends on", () => {
    const full = mf("full", "2026-01-01T00:00:00Z");
    const inc = mf("inc", "2026-07-22T00:00:00Z", ["full"]);
    expect(() => resolveRetention([full, inc], policy({ keepLast: 1 }), NOW)).toThrow(
      RetentionOrphanError,
    );
  });
});
