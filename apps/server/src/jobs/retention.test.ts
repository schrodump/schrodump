// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { Manifest } from "@schrodump/core/manifest";
import type { RetentionPolicy } from "@schrodump/core/retention";
import { runRetention, type RetentionPorts } from "./retention.js";

function manifest(jobId: string, createdAt: string, dependsOn: string[] = []): Manifest {
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

function ports(
  manifests: Manifest[],
  unreadable: string[] = [],
): RetentionPorts & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    loadManifests: () => Promise.resolve({ manifests, unreadable }),
    deleteArtifact: (jobId) => {
      deleted.push(jobId);
      return Promise.resolve();
    },
  };
}

const NOW = new Date("2026-07-23T12:00:00Z");

describe("runRetention", () => {
  it("deletes the resolved delete-set and keeps the rest", async () => {
    const manifests = [
      manifest("old", "2026-07-20T00:00:00Z"),
      manifest("new", "2026-07-22T00:00:00Z"),
    ];
    const p = ports(manifests);
    const result = await runRetention(policy({ keepLast: 1 }), p, NOW);
    expect(result.aborted).toBe(false);
    expect(result.kept).toContain("new");
    expect(p.deleted).toEqual(["old"]);
  });

  it("aborts the whole cycle and deletes nothing when retention would orphan a full", async () => {
    // keeping the incremental would require deleting the full it depends on -> orphan.
    const manifests = [
      manifest("full", "2026-01-01T00:00:00Z"),
      manifest("inc", "2026-07-22T00:00:00Z", ["full"]),
    ];
    const p = ports(manifests);
    const result = await runRetention(policy({ keepLast: 1 }), p, NOW);
    expect(result.aborted).toBe(true);
    expect(result.reason).toMatch(/full|depend/i);
    expect(p.deleted).toEqual([]); // nothing deleted — the full is preserved
  });

  // The landmine this guard exists for: every keep* counter defaults to 0, so a policy created
  // without retention params resolves to "delete everything". Before this check, wiring retention
  // up would have destroyed every backup of every default policy on its first run.
  it("refuses to run at all under an unconfigured (all-zero) policy", async () => {
    const manifests = [
      manifest("a", "2020-01-01T00:00:00Z"),
      manifest("b", "2026-07-22T00:00:00Z"),
    ];
    const p = ports(manifests);
    const result = await runRetention(policy(), p, NOW);

    expect(result.aborted).toBe(true);
    expect(result.reason).toMatch(/not configured/i);
    expect(p.deleted).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it("still refuses when only minAgeBeforeDelete is set — a floor is not a retention intent", async () => {
    const p = ports([manifest("ancient", "2020-01-01T00:00:00Z")]);
    const result = await runRetention(policy({ minAgeBeforeDelete: 1000 }), p, NOW);

    expect(result.aborted).toBe(true);
    expect(p.deleted).toEqual([]);
  });

  // An artifact whose manifest cannot be read is invisible to resolveRetention: it lands in
  // neither keep nor delete. Silently skipping it means the delete-set was computed against an
  // incomplete picture — and a dependency recorded only in the unreadable manifest cannot be
  // honoured. Same philosophy as the orphan check: incomplete picture, delete nothing.
  it("aborts when a manifest cannot be read rather than pruning against a partial view", async () => {
    const p = ports([manifest("readable", "2026-07-22T00:00:00Z")], ["unreadable-job"]);
    const result = await runRetention(policy({ keepLast: 1 }), p, NOW);

    expect(result.aborted).toBe(true);
    expect(result.reason).toMatch(/manifest/i);
    expect(p.deleted).toEqual([]);
  });
});
