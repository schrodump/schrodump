// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { Manifest } from "@schrodump/core/manifest";
import type { RetentionPolicy } from "@schrodump/core/retention";
import { retentionSummary, runRetention, type RetentionPorts } from "./retention.js";

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
  newestVerified: string | null = null,
): RetentionPorts & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    loadManifests: () => Promise.resolve({ manifests, unreadable }),
    newestVerifiedJobId: () => Promise.resolve(newestVerified),
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

  // keepLast 7 under FULL_RESTORE verify, and a schema change makes every new artifact FAIL its
  // restore. Ranked by createdAt alone, the seven FAILED copies fill the window and the one VERIFIED
  // copy behind them is deleted — the job reads "retention kept 7, deleted 1" and the operator holds
  // nothing that restores. This is the failure the README says the product exists to prevent.
  it("never deletes the newest VERIFIED artifact, even when FAILED ones fill keepLast", async () => {
    const manifests = [
      manifest("ancient", "2026-07-01T00:00:00Z"),
      manifest("verified", "2026-07-15T00:00:00Z"),
      ...[16, 17, 18, 19, 20, 21, 22].map((day) =>
        manifest(`failed-${day}`, `2026-07-${day}T00:00:00Z`),
      ),
    ];
    const p = ports(manifests, [], "verified");
    const result = await runRetention(policy({ keepLast: 7 }), p, NOW);

    expect(result.aborted).toBe(false);
    expect(p.deleted).not.toContain("verified");
    expect(result.kept).toContain("verified");
    // Still retention, not a freeze: what is neither in the window nor protected goes.
    expect(p.deleted).toEqual(["ancient"]);
    expect(result.newestVerifiedOutsideWindow).toBe("verified");
    // A kept count above keepLast has to say why, or it reads as a miscount.
    expect(retentionSummary(result)).toBe(
      "retention kept 8, deleted 1 — kept verified outside the window: it is the newest VERIFIED " +
        "artifact, and nothing newer has verified",
    );
  });

  it("says nothing extra when the window already keeps the newest VERIFIED artifact", async () => {
    const manifests = [
      manifest("old", "2026-07-20T00:00:00Z"),
      manifest("verified", "2026-07-21T00:00:00Z"),
      manifest("new", "2026-07-22T00:00:00Z"),
    ];
    const p = ports(manifests, [], "verified");
    const result = await runRetention(policy({ keepLast: 2 }), p, NOW);

    expect(p.deleted).toEqual(["old"]);
    expect(result.newestVerifiedOutsideWindow).toBeNull();
    expect(retentionSummary(result)).toBe("retention kept 2, deleted 1");
  });
});
