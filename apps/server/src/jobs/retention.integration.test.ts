// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Retention is the one job that DELETES a backup, so a unit test with a fake driver is not enough
// evidence: the failure mode that matters is "the DB row went away and the object did not", which
// only a real bucket can show. Opt-in against a real S3-compatible endpoint (MinIO), skipped
// otherwise, exactly like packages/storage's s3.integration.test.ts:
//
//   docker run -p 9000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 \
//     minio/minio server /data
//   export SCHRODUMP_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
//          SCHRODUMP_TEST_S3_ACCESS_KEY=minio SCHRODUMP_TEST_S3_SECRET_KEY=minio123

import { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import type { Manifest } from "@schrodump/core/manifest";
import { createS3Driver } from "@schrodump/storage/s3";
import { artifactKey, manifestKey, writeManifest } from "@schrodump/storage/manifest-sidecar";
import { createRetentionPorts } from "./retention-wiring.js";
import { runRetention } from "./retention.js";

const endpoint = process.env.SCHRODUMP_TEST_S3_ENDPOINT;
const enabled = endpoint !== undefined && endpoint.length > 0;

const ORG = "org-retention-it";
const PREFIX = "retention-it";
const NOW = new Date("2026-07-23T12:00:00Z");

function driverFor(bucket: string) {
  return createS3Driver({
    endpoint,
    region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
    bucket,
    prefix: PREFIX,
    accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "",
    secretAccessKey: process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? "",
    forcePathStyle: true,
  });
}

function manifest(jobId: string, createdAt: string, dependsOn: string[] = []): Manifest {
  return {
    manifestVersion: 1,
    jobId,
    organizationId: ORG,
    engine: "postgres",
    serverVersionNum: 160002,
    toolVersion: "pg_dump 16.2",
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: ["app"], schemas: [], collections: [] },
    sizeRawBytes: 16,
    sizeCompressedBytes: 16,
    checksumAlgorithm: "sha256",
    checksum: "x",
    compression: "zstd",
    encryption: { algorithm: "age", keyIds: ["fp"] },
    dependsOn,
    createdAt,
    durationMs: 1,
  };
}

describe.skipIf(!enabled)("retention integration (real S3-compatible bucket)", () => {
  // Built in beforeAll, not in the describe body: skipIf still EVALUATES this body, and
  // createS3Driver on an undefined endpoint throws — which would fail collection of the whole file
  // on any runner that has not opted in.
  let driver: ReturnType<typeof driverFor>;

  // Lays down a full artifact pair (object + manifest sidecar) for each jobId, as a real backup
  // would, and returns ports wired to the live driver plus an in-memory stand-in for the DB rows.
  async function seed(
    manifests: Manifest[],
  ): Promise<{ rows: Set<string>; ports: ReturnType<typeof createRetentionPorts> }> {
    const rows = new Set<string>();
    for (const m of manifests) {
      await driver.put(artifactKey(PREFIX, ORG, m.jobId), Readable.from([Buffer.from("DUMPDATA")]), {
        contentType: "application/octet-stream",
        partSize: 5 * 1024 * 1024,
        metadata: {},
      });
      await writeManifest(driver, PREFIX, m);
      rows.add(m.jobId);
    }
    const ports = createRetentionPorts({
      driver,
      prefix: PREFIX,
      organizationId: ORG,
      artifactJobIds: () => Promise.resolve([...rows]),
      deleteArtifactRow: (jobId) => {
        rows.delete(jobId);
        return Promise.resolve();
      },
    });
    return { rows, ports };
  }

  const policy = (over: Record<string, number> = {}) => ({
    keepLast: 0,
    keepDaily: 0,
    keepWeekly: 0,
    keepMonthly: 0,
    keepYearly: 0,
    minAgeBeforeDelete: 0,
    ...over,
  });

  beforeAll(async () => {
    driver = driverFor(process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test");
    expect((await driver.canary()).ok).toBe(true);
  });

  it("removes the artifact object, its manifest sidecar and the DB row together", async () => {
    const suffix = `${NOW.getTime()}-a`;
    const old = manifest(`${suffix}-old`, "2026-07-20T00:00:00Z");
    const fresh = manifest(`${suffix}-new`, "2026-07-22T00:00:00Z");
    const { rows, ports } = await seed([old, fresh]);

    const result = await runRetention(policy({ keepLast: 1 }), ports, NOW);

    expect(result.aborted).toBe(false);
    expect(result.deleted).toEqual([old.jobId]);

    // The whole point: object AND sidecar AND row are gone for the pruned one...
    expect(await driver.head(artifactKey(PREFIX, ORG, old.jobId))).toBeNull();
    expect(await driver.head(manifestKey(PREFIX, ORG, old.jobId))).toBeNull();
    expect(rows.has(old.jobId)).toBe(false);

    // ...and every one of them still there for the kept one. A retention that also took the
    // survivor's sidecar would leave an artifact no rebuild could ever re-catalogue.
    expect(await driver.head(artifactKey(PREFIX, ORG, fresh.jobId))).not.toBeNull();
    expect(await driver.head(manifestKey(PREFIX, ORG, fresh.jobId))).not.toBeNull();
    expect(rows.has(fresh.jobId)).toBe(true);

    await driver.delete([artifactKey(PREFIX, ORG, fresh.jobId), manifestKey(PREFIX, ORG, fresh.jobId)]);
  });

  // The landmine: every keep* counter defaults to 0. Against a real bucket, an unguarded run here
  // deletes both objects and both sidecars — every backup the policy has.
  it("deletes NOTHING from the bucket under an unconfigured (all-zero) policy", async () => {
    const suffix = `${NOW.getTime()}-b`;
    const one = manifest(`${suffix}-1`, "2020-01-01T00:00:00Z");
    const two = manifest(`${suffix}-2`, "2026-07-22T00:00:00Z");
    const { rows, ports } = await seed([one, two]);

    const result = await runRetention(policy(), ports, NOW);

    expect(result.aborted).toBe(true);
    expect(result.reason).toMatch(/not configured/i);
    for (const m of [one, two]) {
      expect(await driver.head(artifactKey(PREFIX, ORG, m.jobId))).not.toBeNull();
      expect(await driver.head(manifestKey(PREFIX, ORG, m.jobId))).not.toBeNull();
      expect(rows.has(m.jobId)).toBe(true);
    }

    await driver.delete(
      [one, two].flatMap((m) => [artifactKey(PREFIX, ORG, m.jobId), manifestKey(PREFIX, ORG, m.jobId)]),
    );
  });

  // An artifact whose sidecar is missing from the bucket is invisible to resolveRetention. Pruning
  // anyway would decide against a picture we already know is incomplete.
  it("aborts and deletes nothing when an artifact's manifest is missing from the bucket", async () => {
    const suffix = `${NOW.getTime()}-c`;
    const intact = manifest(`${suffix}-intact`, "2026-07-22T00:00:00Z");
    const stale = manifest(`${suffix}-stale`, "2026-01-01T00:00:00Z");
    const { rows, ports } = await seed([intact, stale]);

    // Simulate the sidecar being lost while the artifact object survives.
    await driver.delete([manifestKey(PREFIX, ORG, stale.jobId)]);

    const result = await runRetention(policy({ keepLast: 1 }), ports, NOW);

    expect(result.aborted).toBe(true);
    expect(result.reason).toMatch(/manifest/i);
    expect(await driver.head(artifactKey(PREFIX, ORG, intact.jobId))).not.toBeNull();
    expect(await driver.head(artifactKey(PREFIX, ORG, stale.jobId))).not.toBeNull();
    expect(rows.size).toBe(2);

    await driver.delete(
      [intact, stale].flatMap((m) => [artifactKey(PREFIX, ORG, m.jobId), manifestKey(PREFIX, ORG, m.jobId)]),
    );
  });

  // Deleting a full while keeping the incremental that depends on it is total data loss.
  it("aborts and deletes nothing when pruning would orphan a full its incremental depends on", async () => {
    const suffix = `${NOW.getTime()}-d`;
    const full = manifest(`${suffix}-full`, "2026-01-01T00:00:00Z");
    const inc = manifest(`${suffix}-inc`, "2026-07-22T00:00:00Z", [`${suffix}-full`]);
    const { rows, ports } = await seed([full, inc]);

    const result = await runRetention(policy({ keepLast: 1 }), ports, NOW);

    expect(result.aborted).toBe(true);
    expect(await driver.head(artifactKey(PREFIX, ORG, full.jobId))).not.toBeNull();
    expect(rows.size).toBe(2);

    await driver.delete(
      [full, inc].flatMap((m) => [artifactKey(PREFIX, ORG, m.jobId), manifestKey(PREFIX, ORG, m.jobId)]),
    );
  });
});
