// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Rebuilding has to survive a catalog that is only PARTLY missing, because that is the ordinary
// shape of the loss and precisely when a rebuild gets run.
//
// The skip list is built from Artifact.jobId — "is this manifest already imported" — which is a
// different question from "does a BackupJob with this id exist". They come apart the moment the
// artifact row is gone and the job row is not. With create() that collision threw a unique
// constraint error, and since importArtifact is awaited per manifest the WHOLE rebuild aborted on
// the first one: a single stale job row made the documented recovery floor unusable, answering 500
// with no explanation. Observed on the shipped deployment.

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createCatalogRebuildPorts } from "./catalog-rebuild-wiring.js";

const MANIFEST = {
  jobId: "job-1",
  organizationId: "org-1",
  destinationId: "dest-1",
  engine: "postgres",
  executionMode: "STREAM",
  serverVersionNum: 180000,
  sizeRawBytes: 10,
  sizeCompressedBytes: 5,
  checksumAlgorithm: "sha256",
  checksum: "a".repeat(64),
  compression: "gzip",
  encryption: { keyIds: ["k1"] },
  dependsOn: [],
  createdAt: new Date().toISOString(),
} as unknown as Parameters<ReturnType<typeof createCatalogRebuildPorts>["importArtifact"]>[0];

function fakePrisma() {
  const calls: string[] = [];
  const prisma = {
    $extends: () => prisma,
    artifact: {
      findMany: () => Promise.resolve([]),
      create: () => {
        calls.push("artifact.create");
        return Promise.resolve({});
      },
    },
    backupJob: {
      create: () => {
        calls.push("backupJob.create");
        return Promise.reject(new Error("Unique constraint failed on the fields: (`id`)"));
      },
      upsert: () => {
        calls.push("backupJob.upsert");
        return Promise.resolve({ id: "job-1" });
      },
    },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

describe("catalog rebuild — importing a manifest whose job row survived", () => {
  it("upserts the job rather than creating it, so a surviving row is not a collision", async () => {
    const { prisma, calls } = fakePrisma();
    const ports = createCatalogRebuildPorts({
      prisma,
      organizationId: "org-1",
      destinationId: "dest-1",
      driver: {} as never,
      prefix: "s",
    });

    await ports.importArtifact(MANIFEST);

    // create() on a surviving job id is what threw; the fake rejects it to make that concrete.
    expect(calls).toEqual(["backupJob.upsert", "artifact.create"]);
    expect(calls).not.toContain("backupJob.create");
  });
});
