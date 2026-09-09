// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { LIST_PAGE_SIZE } from "./jobs.js";
import { generateAgeKeyPair } from "../crypto/artifact.js";
import {
  createEncryptionKeyService,
  createJobsService,
  ARTIFACT_SUBJECT_INCLUDE, JOB_SUBJECT_INCLUDE,
  toArtifactRecord,
  toJobRecord,
} from "./wiring.js";

// A full Artifact row as Prisma returns it — sizes are BigInt, plus internal columns the API must
// not expose.
const row = {
  id: "a1",
  organizationId: "o1",
  jobId: "j1",
  destinationId: "d1",
  state: "UNOBSERVED",
  verifiedLevel: null,
  verifiedDegraded: false,
  bucketKey: "org/backup.age",
  manifestKey: "org/backup.manifest.json",
  engine: "postgres",
  executionMode: "STAGED",
  sourceHasOplog: null,
  dumpIsMultiDatabase: null,
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
  it("names the target and policy the artifact was written for, resolved through its job", () => {
    // The row used to lead with the bucket key — a storage path — because nothing on it said WHAT
    // was backed up. The job knows: it ran under a policy, and the policy points at a target.
    const record = toArtifactRecord({
      ...row,
      job: { policy: { name: "nightly-eu", target: { name: "payments-us" } } },
    });
    expect(record.targetName).toBe("payments-us");
    expect(record.policyName).toBe("nightly-eu");
  });

  it("answers null, not a placeholder, when the policy is gone or the relation was not loaded", () => {
    expect(toArtifactRecord(row).targetName).toBe(null);
    expect(toArtifactRecord({ ...row, job: { policy: null } }).targetName).toBe(null);
    expect(toArtifactRecord({ ...row, job: { policy: null } }).policyName).toBe(null);
  });

  it("converts BigInt sizes to number so Fastify can JSON-serialize the row", () => {
    const record = toArtifactRecord(row);
    expect(record.sizeRawBytes).toBe(9_000_000_000);
    expect(record.sizeCompressedBytes).toBe(1_500_000_000);
    expect(typeof record.sizeRawBytes).toBe("number");
    // The original bug: a raw BigInt reaching JSON.stringify throws (and Fastify 500s).
    expect(() => JSON.stringify(record)).not.toThrow();
  });

  it("drops organizationId but now exposes updatedAt, which the freshness display reads", () => {
    const record = toArtifactRecord(row);
    // organizationId stays internal — the client is already scoped to its org and never needs it.
    expect("organizationId" in record).toBe(false);
    // updatedAt is deliberately exposed now: the row renders "verified N ago" from it. It used to
    // be dropped as internal; surfacing it is the change this asserts.
    expect("updatedAt" in record).toBe(true);
  });

  // The restore gate is executionMode-based (runRestoreJob refuses STAGED). Dropping the column
  // here is what left the web's canRestoreEngine unable to gate, so the UI offered a restore the
  // server would refuse. The field must survive the mapping.
  it("carries executionMode so the UI can gate restore the same way the server does", () => {
    expect(toArtifactRecord(row).executionMode).toBe("STAGED");
    expect(toArtifactRecord({ ...row, executionMode: "STREAM" }).executionMode).toBe("STREAM");
  });

  // Without these the dashboard cannot tell a green proven by a real restore from a checksum-only
  // one, and a downgraded checksum (an unscoped replica-set dump) reads as a full-restore green.
  it("carries the verify level and its degraded flag so the UI can tell the greens apart", () => {
    const full = toArtifactRecord({ ...row, verifiedLevel: "FULL_RESTORE", verifiedDegraded: false });
    expect(full.verifiedLevel).toBe("FULL_RESTORE");
    expect(full.verifiedDegraded).toBe(false);
    const degraded = toArtifactRecord({ ...row, verifiedLevel: "CHECKSUM", verifiedDegraded: true });
    expect(degraded.verifiedLevel).toBe("CHECKSUM");
    expect(degraded.verifiedDegraded).toBe(true);
    // null survives as null — an artifact no verify has reached a verdict on, not a false "checksum".
    expect(toArtifactRecord(row).verifiedLevel).toBe(null);
  });
});

describe("createJobsService.deleteArtifact", () => {
  interface Op {
    model: string;
    operation: string;
    args: Record<string, unknown>;
    query: (a: Record<string, unknown>) => Promise<unknown>;
  }
  function fakeFor(artifactRow: Record<string, unknown> | null) {
    const calls: { model: string; operation: string; args: Record<string, unknown> }[] = [];
    let wrap: ((op: Op) => Promise<unknown>) | null = null;
    const call = (model: string, operation: string, args: Record<string, unknown>, result: unknown) => {
      const run = (final: Record<string, unknown>) => {
        calls.push({ model, operation, args: final });
        return Promise.resolve(result);
      };
      return wrap === null ? run(args) : wrap({ model, operation, args, query: run });
    };
    const base = {
      artifact: {
        findFirst: (a: Record<string, unknown>) => call("Artifact", "findFirst", a, artifactRow),
        delete: (a: Record<string, unknown>) => call("Artifact", "delete", a, {}),
      },
      // Destination reported gone, so driverForDestination returns null: the objects are already
      // unreachable and the row must still be removable. This keeps the real S3 driver out of a unit
      // test while still exercising the whole delete path through to artifact.delete.
      storageDestination: {
        findFirst: (a: Record<string, unknown>) => call("StorageDestination", "findFirst", a, null),
      },
      $extends: (ext: { query: { $allModels: { $allOperations: (op: Op) => Promise<unknown> } } }) => {
        wrap = ext.query.$allModels.$allOperations;
        return base;
      },
    };
    return { calls, prisma: base as unknown as PrismaClient };
  }
  const svc = (prisma: PrismaClient) =>
    createJobsService(prisma, Buffer.alloc(32), { record: () => undefined });
  const deletedRow = (calls: { model: string; operation: string }[]) =>
    calls.some((c) => c.model === "Artifact" && c.operation === "delete");

  it("refuses a missing artifact as not_found, without touching storage or the row", async () => {
    const f = fakeFor(null);
    expect(await svc(f.prisma).deleteArtifact("o", "gone", { acknowledgeVerified: false })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(deletedRow(f.calls)).toBe(false);
  });

  it("refuses a VERIFIED artifact without acknowledgement, and does NOT delete it", async () => {
    const f = fakeFor({ id: "a1", state: "VERIFIED", destinationId: "d1", bucketKey: "k", manifestKey: "m" });
    expect(await svc(f.prisma).deleteArtifact("o", "a1", { acknowledgeVerified: false })).toEqual({
      ok: false,
      reason: "verified_needs_ack",
    });
    // The guard is the whole point: drop it and the delete proceeds (destination gone → row deleted).
    expect(deletedRow(f.calls)).toBe(false);
  });

  it("deletes a FAILED artifact's row with no acknowledgement needed", async () => {
    const f = fakeFor({ id: "a1", state: "FAILED", destinationId: "d1", bucketKey: "k", manifestKey: "m" });
    expect(await svc(f.prisma).deleteArtifact("o", "a1", { acknowledgeVerified: false })).toEqual({
      ok: true,
    });
    const del = f.calls.find((c) => c.model === "Artifact" && c.operation === "delete");
    // scopedPrisma injects the organizationId into the where — the delete is org-scoped, so one
    // organization can never delete another's artifact by id. Asserting both pins that too.
    expect((del?.args as { where?: { id?: string; organizationId?: string } }).where).toEqual({
      id: "a1",
      organizationId: "o",
    });
  });

  it("deletes a VERIFIED artifact once the acknowledgement is given", async () => {
    const f = fakeFor({ id: "a1", state: "VERIFIED", destinationId: "d1", bucketKey: "k", manifestKey: "m" });
    expect(await svc(f.prisma).deleteArtifact("o", "a1", { acknowledgeVerified: true })).toEqual({
      ok: true,
    });
    expect(deletedRow(f.calls)).toBe(true);
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
        return Promise.resolve(operation === "count" ? 0 : operation === "findFirst" ? null : []);
      };
      return wrap === null ? run(args) : wrap({ model, operation, args, query: run });
    };
    const model = (name: string) => ({
      findMany: (args: Record<string, unknown>) => call(name, "findMany", args),
      count: (args: Record<string, unknown> = {}) => call(name, "count", args),
      groupBy: (args: Record<string, unknown>) => call(name, "groupBy", args),
      findFirst: (args: Record<string, unknown>) => call(name, "findFirst", args),
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

  it("asks the database for exactly the relations the mapper reads", async () => {
    // The mapper and the query live in different places and neither one fails loudly if the other
    // changes: drop the include and every row silently reports a null target, which reads like a
    // deployment with no policies rather than like a bug.
    const spy = spyPrisma();

    await createJobsService(spy.prisma, Buffer.alloc(32), { record: () => undefined }).listJobs(
      "org-1",
    );

    const call = spy.calls.find((c) => c.model === "BackupJob" && c.operation === "findMany");
    expect(call?.args.include).toEqual(JOB_SUBJECT_INCLUDE);
  });

  it("bounds the artifact list and asks the database for the counts", async () => {
    const spy = spyPrisma();
    const result = await createJobsService(spy.prisma, Buffer.alloc(32), { record: () => undefined }).listArtifacts("org-1");
    const call = spy.calls.find((c) => c.model === "Artifact" && c.operation === "findMany");
    expect((call?.args as { where?: { organizationId?: string } }).where?.organizationId).toBe("org-1");
    expect((call?.args as { take?: number } | undefined)?.take).toBe(LIST_PAGE_SIZE);
    // The subject rides along in the same query, declared once so query and mapper agree.
    expect((call?.args as { include?: unknown } | undefined)?.include).toEqual(ARTIFACT_SUBJECT_INCLUDE);
    // Zeroes because the fake groupBy returns nothing — the point is that the shape is present and
    // comes from the database rather than from items.length.
    expect(result.counts).toEqual({ VERIFIED: 0, UNOBSERVED: 0, FAILED: 0 });
  });

  it("answers the catalog header from the table: how the verified were verified, how many buckets, the oldest open question", async () => {
    const spy = spyPrisma();
    const result = await createJobsService(spy.prisma, Buffer.alloc(32), { record: () => undefined }).listArtifacts("org-1");

    const groups = spy.calls.filter((c) => c.model === "Artifact" && c.operation === "groupBy");
    expect(groups.map((c) => (c.args as { by: string[] }).by)).toEqual([["state"], ["verifiedLevel"], ["destinationId"]]);
    // Only the VERIFIED ones are split by level: an UNOBSERVED artifact has no level to count.
    expect((groups[1]?.args as { where?: { state?: string } }).where?.state).toBe("VERIFIED");
    const oldest = spy.calls.find((c) => c.model === "Artifact" && c.operation === "findFirst");
    expect((oldest?.args as { where?: { state?: string }; orderBy?: unknown }).where?.state).toBe("UNOBSERVED");
    expect((oldest?.args as { orderBy?: unknown }).orderBy).toEqual({ createdAt: "asc" });
    expect(result.verifiedByLevel).toEqual({ FULL_RESTORE: 0, CHECKSUM: 0 });
    expect(result.destinations).toBe(0);
    expect(result.oldestUnobserved).toBeNull();
  });

  it("bounds the job list", async () => {
    const spy = spyPrisma();
    await createJobsService(spy.prisma, Buffer.alloc(32), { record: () => undefined }).listJobs("org-1");
    const call = spy.calls.find((c) => c.model === "BackupJob" && c.operation === "findMany");
    expect((call?.args as { where?: { organizationId?: string } }).where?.organizationId).toBe("org-1");
    expect((call?.args as { take?: number } | undefined)?.take).toBe(LIST_PAGE_SIZE);
  });

  it("asks the database, not the page, for the job counts and the header stats", async () => {
    const spy = spyPrisma();
    const result = await createJobsService(spy.prisma, Buffer.alloc(32), { record: () => undefined }).listJobs("org-1");

    // One groupBy per axis, both scoped to the organization.
    const groups = spy.calls.filter((c) => c.model === "BackupJob" && c.operation === "groupBy");
    expect(groups.map((c) => (c.args as { by: string[] }).by)).toEqual([["state"], ["kind"]]);
    for (const group of groups) {
      expect((group.args as { where?: { organizationId?: string } }).where?.organizationId).toBe("org-1");
    }
    // Every enum member present at zero: a chip per state and per kind, none missing.
    expect(result.counts.byState).toEqual({
      PENDING: 0,
      RUNNING: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      INCONCLUSIVE: 0,
      CANCELLED: 0,
    });
    expect(result.counts.byKind).toEqual({ BACKUP: 0, RESTORE: 0, VERIFY: 0, RETENTION: 0 });
    // The 24h windows are counted with a finishedAt bound, per state, over the whole table.
    // The plain total also carries a where (the organization scope), so the windows are told apart
    // by the state they count, not by the presence of a filter.
    const states = spy.calls
      .filter((c) => c.model === "BackupJob" && c.operation === "count")
      .map((c) => (c.args as { where?: { state?: string } }).where?.state)
      .filter((state) => state !== undefined);
    expect(states).toEqual(["FAILED", "INCONCLUSIVE"]);
    // The oldest pending job is the head of an ascending scheduledAt query, never a page scan.
    const oldest = spy.calls.find((c) => c.model === "BackupJob" && c.operation === "findFirst");
    expect((oldest?.args as { orderBy?: unknown }).orderBy).toEqual({ scheduledAt: "asc" });
    expect(result.stats).toEqual({ oldestPendingScheduledAt: null, failedLast24h: 0, inconclusiveLast24h: 0 });
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

// The operator cannot otherwise tell a point-in-time-consistent replica-set archive from an
// ordinary one, and that is the whole difference between them on the day it matters. It was
// recorded on the row and dropped by the mapper, so `GET /artifacts` could not answer the question
// at all — which is how the compose smoke ended up reading the column straight from the database.
describe("toArtifactRecord carries the oplog fact", () => {
  it("passes dumpIsMultiDatabase through, including the null that means 'never recorded'", () => {
    // The UI withholds a sub-cluster restore on true AND on null, and only a recorded false clears
    // it. Coercing null to false here would hand the interface a permission the server refuses.
    expect(toArtifactRecord({ ...row, dumpIsMultiDatabase: true }).dumpIsMultiDatabase).toBe(true);
    expect(toArtifactRecord({ ...row, dumpIsMultiDatabase: false }).dumpIsMultiDatabase).toBe(
      false,
    );
    expect(toArtifactRecord({ ...row, dumpIsMultiDatabase: null }).dumpIsMultiDatabase).toBe(null);
  });

  it("passes sourceHasOplog through, including the null that means 'not a mongo dump'", () => {
    expect(toArtifactRecord({ ...row, sourceHasOplog: true }).sourceHasOplog).toBe(true);
    expect(toArtifactRecord({ ...row, sourceHasOplog: false }).sourceHasOplog).toBe(false);
    expect(toArtifactRecord({ ...row, sourceHasOplog: null }).sourceHasOplog).toBe(null);
  });
});

// A job row said what KIND it was and nothing about WHAT it was for, so an operator watching two
// backups run could not tell which of their databases was being read. The answer existed — as a
// cuid inside the correlationId.
describe("a job says which database it is about", () => {
  const scalars = { id: "j1", kind: "BACKUP", state: "RUNNING" } as const;

  it("resolves a BACKUP through the policy it belongs to", () => {
    const out = toJobRecord({ ...scalars, policy: { name: "nightly", target: { name: "orders" } } });

    expect(out.targetName).toBe("orders");
    expect(out.policyName).toBe("nightly");
  });

  it("resolves a VERIFY through the artifact it acts on, and the job that produced it", () => {
    // The route that is easy to forget: a verify has no policy of its own, so without this half
    // exactly the rows an operator stares at during an incident stay anonymous.
    const out = toJobRecord({
      ...scalars,
      kind: "VERIFY",
      policy: null,
      verifyArtifact: {
        id: "a1",
        state: "UNOBSERVED",
        job: { policy: { name: "nightly", target: { name: "orders" } } },
      },
    });

    expect(out.targetName).toBe("orders");
    expect(out.policyName).toBe("nightly");
  });

  it("leaves a manual run's policy null instead of inventing a name for it", () => {
    // "unknown" here would be indistinguishable from a real policy called unknown, and would hide
    // the difference between "nobody scheduled this" and "the policy row is gone".
    const out = toJobRecord({ ...scalars, policy: null });

    expect(out.policyName).toBeNull();
    expect(out.targetName).toBeNull();
  });

  it("points at the artifact a VERIFY acts on, with the state it is in", () => {
    // The ledger row says what a run touched and whether anyone has looked at it yet; the state
    // rides with the id so the row needs no second request to colour it.
    const out = toJobRecord({
      ...scalars,
      kind: "VERIFY",
      policy: null,
      verifyArtifact: { id: "a1", state: "UNOBSERVED", job: { policy: null } },
    });

    expect(out.artifact).toEqual({ id: "a1", state: "UNOBSERVED" });
  });

  it("points at the artifact a BACKUP produced, and at nothing while it has not", () => {
    const written = toJobRecord({
      ...scalars,
      policy: null,
      artifact: { id: "a2", state: "VERIFIED" },
    });
    const running = toJobRecord({ ...scalars, policy: null, artifact: null });

    expect(written.artifact).toEqual({ id: "a2", state: "VERIFIED" });
    expect(running.artifact).toBeNull();
  });

  it("exposes a RESTORE's scope and nothing else from its params, null when they do not parse", () => {
    const scoped = toJobRecord({
      ...scalars,
      kind: "RESTORE",
      policy: null,
      restoreParams: { target: "DATABASE", confirmExistingDatabase: true, triggeredByUserId: "u1" },
    });
    const garbage = toJobRecord({ ...scalars, kind: "RESTORE", policy: null, restoreParams: "nope" });

    expect(scoped.restoreTarget).toBe("DATABASE");
    expect(garbage.restoreTarget).toBeNull();
    // A BACKUP has no scope; the field is null, not absent, so the shape is one shape.
    expect(toJobRecord({ ...scalars, policy: null }).restoreTarget).toBeNull();
  });

  it("carries the job's own fields through and drops the relations", () => {
    const out = toJobRecord({
      ...scalars,
      correlationId: "backup:p1",
      policy: { name: "nightly", target: { name: "orders" } },
    });

    expect(out.correlationId).toBe("backup:p1");
    expect(out.state).toBe("RUNNING");
    expect(out).not.toHaveProperty("policy");
    expect(out).not.toHaveProperty("verifyArtifact");
  });
});
