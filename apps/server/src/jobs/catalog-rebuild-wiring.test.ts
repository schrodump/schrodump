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
  scope: { databases: [], schemas: [], collections: [] },
  encryption: { keyIds: ["k1"] },
  dependsOn: [],
  createdAt: new Date().toISOString(),
} as unknown as Parameters<ReturnType<typeof createCatalogRebuildPorts>["importArtifact"]>[0];

function fakePrisma() {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const prisma = {
    $extends: () => prisma,
    artifact: {
      findMany: () => Promise.resolve([]),
      create: (args: { data: Record<string, unknown> }) => {
        calls.push("artifact.create");
        created.push(args.data);
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
  return { prisma, calls, created };
}

// What a rebuild writes onto the Artifact row for one manifest.
async function importedRow(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { prisma, created } = fakePrisma();
  const ports = createCatalogRebuildPorts({
    prisma,
    organizationId: "org-1",
    destinationId: "dest-1",
    driver: {} as never,
    prefix: "s",
  });
  await ports.importArtifact({ ...MANIFEST, ...over } as typeof MANIFEST);
  return created[0] as Record<string, unknown>;
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

// A rebuild is the documented recovery floor: the row it writes is the only description of the
// artifact that will exist. Every fact the manifest already carries has to survive the trip, and the
// two below decide whether the artifact can be RESTORED at all afterwards.
describe("catalog rebuild — facts the manifest carries must survive the trip", () => {
  it("preserves the execution mode instead of letting the column default to STREAM", async () => {
    // A STAGED artifact is a tar; the restore pipeline unpacks it only when the row says STAGED.
    // Omitting the field left the schema default in place, so a rebuild silently relabelled every
    // staged artifact as a plain stream — and its restore would then feed a tar to the client.
    const row = await importedRow({ executionMode: "STAGED" });
    expect(row.executionMode).toBe("STAGED");
  });

  it("recovers the multi-database fact from the dump scope in the manifest", async () => {
    const row = await importedRow({
      engine: "mysql",
      scope: { databases: ["app", "billing"], schemas: [], collections: [] },
    });
    expect(row.dumpIsMultiDatabase).toBe(true);
  });

  it("records a single-database mysql script as the recorded false that clears the restore gate", async () => {
    const row = await importedRow({
      engine: "mysql",
      scope: { databases: ["app"], schemas: [], collections: [] },
    });
    expect(row.dumpIsMultiDatabase).toBe(false);
  });

  it("leaves the fact null for an engine it says nothing about", async () => {
    const row = await importedRow();
    expect(row.dumpIsMultiDatabase).toBeNull();
  });
});
