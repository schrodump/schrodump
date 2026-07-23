// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { Manifest } from "@schrodump/core/manifest";
import { rebuildCatalog, type CatalogRebuildPorts } from "./catalog-rebuild.js";

function manifest(jobId: string): Manifest {
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
    dependsOn: [],
    createdAt: "2026-07-23T10:00:00Z",
    durationMs: 1,
  };
}

function makePorts(
  manifests: Manifest[],
  existing: string[],
): CatalogRebuildPorts & { imported: string[] } {
  const imported: string[] = [];
  return {
    imported,
    scan: () => Promise.resolve(manifests),
    existingJobIds: () => Promise.resolve(new Set(existing)),
    importArtifact: (m) => {
      imported.push(m.jobId);
      return Promise.resolve();
    },
  };
}

describe("rebuildCatalog", () => {
  it("rebuilds the whole catalog from the bucket when the metadata DB is empty", async () => {
    const ports = makePorts([manifest("j1"), manifest("j2")], []);
    const result = await rebuildCatalog(ports);
    expect(result.imported).toEqual(["j1", "j2"]);
    expect(result.skipped).toEqual([]);
    expect(ports.imported).toEqual(["j1", "j2"]);
  });

  it("imports only the artifacts missing from the DB", async () => {
    const ports = makePorts([manifest("j1"), manifest("j2"), manifest("j3")], ["j2"]);
    const result = await rebuildCatalog(ports);
    expect(result.imported).toEqual(["j1", "j3"]);
    expect(result.skipped).toEqual(["j2"]);
  });
});
