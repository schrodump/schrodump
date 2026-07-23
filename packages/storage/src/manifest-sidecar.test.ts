// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SchrodumpError } from "@schrodump/core/errors";
import { serializeManifest, type Manifest } from "@schrodump/core/manifest";
import type { ObjectMeta, Page, PutResult, StorageDriver } from "./driver.js";
import {
  artifactKey,
  manifestKey,
  readManifest,
  scanManifests,
  writeManifest,
} from "./manifest-sidecar.js";

// In-memory StorageDriver. `pageSize` forces multi-page listings; `failGetKeys` simulates a
// typed driver error on read.
class FakeStorageDriver implements StorageDriver {
  readonly store = new Map<string, Buffer>();
  pageSize = 1000;
  readonly failGetKeys = new Set<string>();

  async put(key: string, body: Readable): Promise<PutResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const buf = Buffer.concat(chunks);
    this.store.set(key, buf);
    return { etag: "fake", sizeBytes: buf.length, checksum: null };
  }

  async get(key: string): Promise<Readable> {
    if (this.failGetKeys.has(key)) {
      throw new SchrodumpError("get failed", { code: "STORAGE_GET_FAILED", correlationId: "t" });
    }
    const buf = this.store.get(key);
    if (buf === undefined) {
      throw new SchrodumpError("not found", { code: "STORAGE_GET_FAILED", correlationId: "t" });
    }
    return Readable.from([buf]);
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const buf = this.store.get(key);
    if (buf === undefined) return null;
    return { key, sizeBytes: buf.length, etag: "fake", lastModified: new Date(0) };
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async list(prefix: string, cursor?: string): Promise<Page<ObjectMeta>> {
    const all = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor !== undefined ? Number(cursor) : 0;
    const items: ObjectMeta[] = [];
    for (const key of all.slice(start, start + this.pageSize)) {
      const buf = this.store.get(key);
      if (buf === undefined) continue;
      items.push({ key, sizeBytes: buf.length, etag: "fake", lastModified: new Date(0) });
    }
    const next = start + this.pageSize;
    return { items, cursor: next < all.length ? String(next) : null };
  }

  async canary(): Promise<{ ok: boolean; failedOperation: null; message: null }> {
    return { ok: true, failedOperation: null, message: null };
  }
}

function makeManifest(jobId: string): Manifest {
  return {
    manifestVersion: 1,
    jobId,
    organizationId: "org1",
    engine: "postgres",
    serverVersionNum: 160002,
    toolVersion: "pg_dump 16.2",
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: ["app"], schemas: [], collections: [] },
    sizeRawBytes: 10,
    sizeCompressedBytes: 5,
    checksumAlgorithm: "sha256",
    checksum: "abc",
    compression: "zstd",
    encryption: { algorithm: "age", keyIds: ["fp"] },
    dependsOn: [],
    createdAt: "2026-07-23T10:00:00Z",
    durationMs: 100,
  };
}

describe("key construction", () => {
  it("builds artifact and manifest keys under prefix/org/job", () => {
    expect(artifactKey("schrodump", "org1", "job1")).toBe("schrodump/org1/job1/artifact.bin");
    expect(manifestKey("schrodump", "org1", "job1")).toBe("schrodump/org1/job1/manifest.json");
  });

  it("normalizes surrounding slashes and an empty prefix", () => {
    expect(manifestKey("/schrodump/", "org1", "job1")).toBe("schrodump/org1/job1/manifest.json");
    expect(manifestKey("", "org1", "job1")).toBe("org1/job1/manifest.json");
  });
});

describe("writeManifest / readManifest", () => {
  it("writes the deterministic serialization and reads it back", async () => {
    const driver = new FakeStorageDriver();
    const manifest = makeManifest("job1");
    await writeManifest(driver, "schrodump", manifest);

    const stored = driver.store.get(manifestKey("schrodump", "org1", "job1"));
    expect(stored?.toString("utf8")).toBe(serializeManifest(manifest));

    const result = await readManifest(driver, "schrodump", "org1", "job1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toEqual(manifest);
  });

  it("propagates a typed SchrodumpError from the driver", async () => {
    const driver = new FakeStorageDriver();
    await writeManifest(driver, "schrodump", makeManifest("job1"));
    driver.failGetKeys.add(manifestKey("schrodump", "org1", "job1"));
    await expect(readManifest(driver, "schrodump", "org1", "job1")).rejects.toBeInstanceOf(
      SchrodumpError,
    );
  });
});

describe("scanManifests", () => {
  it("rebuilds the catalog across multiple list pages, ignoring non-manifest objects", async () => {
    const driver = new FakeStorageDriver();
    driver.pageSize = 1; // force pagination
    const jobs = ["job1", "job2", "job3"];
    for (const job of jobs) await writeManifest(driver, "schrodump", makeManifest(job));
    await driver.put(artifactKey("schrodump", "org1", "job1"), Readable.from([Buffer.from("bin")]));

    const result = await scanManifests(driver, "schrodump");
    expect(result.manifests.map((m) => m.jobId).sort()).toEqual(jobs);
    expect(result.invalid).toEqual([]);
  });

  it("collects invalid manifest.json objects without throwing", async () => {
    const driver = new FakeStorageDriver();
    const badKey = manifestKey("schrodump", "org1", "bad");
    await driver.put(badKey, Readable.from([Buffer.from("{not json")]));

    const result = await scanManifests(driver, "schrodump");
    expect(result.manifests).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.key).toBe(badKey);
  });
});
