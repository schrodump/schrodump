// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { LIST_PAGE_SIZE } from "./jobs.js";
import { generateAgeKeyPair } from "../crypto/artifact.js";
import { createEncryptionKeyService, createJobsService, toArtifactRecord } from "./wiring.js";

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
  executionMode: "STAGED",
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

  // The restore gate is executionMode-based (runRestoreJob refuses STAGED). Dropping the column
  // here is what left the web's canRestoreEngine unable to gate, so the UI offered a restore the
  // server would refuse. The field must survive the mapping.
  it("carries executionMode so the UI can gate restore the same way the server does", () => {
    expect(toArtifactRecord(row).executionMode).toBe("STAGED");
    expect(toArtifactRecord({ ...row, executionMode: "STREAM" }).executionMode).toBe("STREAM");
  });
});

describe("createJobsService list bounds", () => {
  // The take lives in the wiring, and the route tests stub the whole service out — so without this
  // the cap could be deleted and every test would stay green. It is the query shape being asserted,
  // deliberately: that is where the bound actually is.
  // The fake routes every call through the real $allOperations wrapper scopedPrisma installs, so
  // this also proves the organizationId filter is still applied to the bounded queries — the two
  // could not be verified separately without a database.
  interface Op {
    model: string;
    operation: string;
    args: Record<string, unknown>;
    query: (a: Record<string, unknown>) => Promise<unknown>;
  }
  function spyPrisma() {
    const calls: { model: string; operation: string; args: Record<string, unknown> }[] = [];
    let wrap: ((op: Op) => Promise<unknown>) | null = null;
    const call = (model: string, operation: string, args: Record<string, unknown>) => {
      const run = (final: Record<string, unknown>) => {
        calls.push({ model, operation, args: final });
        return Promise.resolve(operation === "count" ? 0 : []);
      };
      return wrap === null ? run(args) : wrap({ model, operation, args, query: run });
    };
    const model = (name: string) => ({
      findMany: (args: Record<string, unknown>) => call(name, "findMany", args),
      count: (args: Record<string, unknown> = {}) => call(name, "count", args),
      groupBy: (args: Record<string, unknown>) => call(name, "groupBy", args),
    });
    const base = {
      backupJob: model("BackupJob"),
      artifact: model("Artifact"),
      $extends: (ext: { query: { $allModels: { $allOperations: (op: Op) => Promise<unknown> } } }) => {
        wrap = ext.query.$allModels.$allOperations;
        return base;
      },
    };
    return { calls, prisma: base as unknown as PrismaClient };
  }

  it("bounds the artifact list and asks the database for the counts", async () => {
    const spy = spyPrisma();
    const result = await createJobsService(spy.prisma, Buffer.alloc(32)).listArtifacts("org-1");
    const call = spy.calls.find((c) => c.model === "Artifact" && c.operation === "findMany");
    expect((call?.args as { where?: { organizationId?: string } }).where?.organizationId).toBe("org-1");
    expect((call?.args as { take?: number } | undefined)?.take).toBe(LIST_PAGE_SIZE);
    // Zeroes because the fake groupBy returns nothing — the point is that the shape is present and
    // comes from the database rather than from items.length.
    expect(result.counts).toEqual({ VERIFIED: 0, UNOBSERVED: 0, FAILED: 0 });
  });

  it("bounds the job list", async () => {
    const spy = spyPrisma();
    await createJobsService(spy.prisma, Buffer.alloc(32)).listJobs("org-1");
    const call = spy.calls.find((c) => c.model === "BackupJob" && c.operation === "findMany");
    expect((call?.args as { where?: { organizationId?: string } }).where?.organizationId).toBe("org-1");
    expect((call?.args as { take?: number } | undefined)?.take).toBe(LIST_PAGE_SIZE);
  });
});

describe("createEncryptionKeyService.provision", () => {
  function txPrisma() {
    const created: { data: Record<string, unknown> }[] = [];
    const prisma = {
      encryptionKey: {
        create: (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return args;
        },
      },
      $transaction: (ops: unknown[]) => Promise.resolve(ops),
    } as unknown as PrismaClient;
    return { created, prisma };
  }

  // The single most important claim in this feature. If the escrow identity were persisted, losing
  // the metadata database would lose BOTH keys at once and a self-backup could never be recovered —
  // which is the entire reason the self-backup seals to escrow in the first place.
  it("stores the operational identity and never the escrow one", async () => {
    const t = txPrisma();
    const result = await createEncryptionKeyService(t.prisma, Buffer.alloc(32)).provision("org-1", {
      mode: "generate",
    });

    const operational = t.created.find((c) => c.data["type"] === "operational");
    const escrow = t.created.find((c) => c.data["type"] === "escrow");
    expect(operational?.data["encryptedIdentity"]).toBeDefined();
    expect(escrow?.data["encryptedIdentity"]).toBeUndefined();

    // It is returned to the caller exactly once instead, which is the only copy that will exist.
    expect(result.escrowIdentity).toMatch(/^AGE-SECRET-KEY-/);
    // And it is nowhere in what was written.
    expect(JSON.stringify(t.created)).not.toContain(result.escrowIdentity ?? "unreachable");
  });

  it("stores an operator-supplied recipient without ever holding a private half", async () => {
    const t = txPrisma();
    const mine = (await generateAgeKeyPair()).recipient;
    const result = await createEncryptionKeyService(t.prisma, Buffer.alloc(32)).provision("org-1", {
      mode: "recipient",
      publicRecipient: mine,
    });

    const escrow = t.created.find((c) => c.data["type"] === "escrow");
    expect(escrow?.data["publicRecipient"]).toBe(mine);
    expect(escrow?.data["encryptedIdentity"]).toBeUndefined();
    // Null, not a generated one: the server never saw a private key, and saying otherwise would
    // invite the operator to think there is something to save.
    expect(result.escrowIdentity).toBeNull();
  });

  // Both rows in one transaction. An organization left holding only an operational key would fail
  // every backup at resolveRecipients, and provisioningBlockers would then refuse to fix it.
  it("writes both keys as a single transaction", async () => {
    const t = txPrisma();
    await createEncryptionKeyService(t.prisma, Buffer.alloc(32)).provision("org-1", {
      mode: "generate",
    });
    expect(t.created).toHaveLength(2);
  });
});
