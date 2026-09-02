// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ProbeResult as EngineProbeResult } from "@schrodump/engines/probe/types";
import { loadEnv } from "../env.js";
import {
  createJobExecutor,
  createWorkerStore,
  originDatabaseFor,
  resolveVerifyPlan,
  sanitizeReason,
  sourceHasOplogFor,
  toBackupProbe,
  toRetentionPolicy,
  verifyEngineWiring,
} from "./worker-wiring.js";
import type { ClaimedJob } from "./worker.js";

describe("toRetentionPolicy", () => {
  // Prisma hands back minAgeBeforeDeleteMs as BigInt; core's RetentionPolicy is all numbers, and
  // BigInt arithmetic against a number throws. Narrowing here is what keeps resolveRetention pure.
  it("narrows the BigInt minAge to a number so the pure resolver can do arithmetic on it", () => {
    const policy = toRetentionPolicy({
      keepLast: 7,
      keepDaily: 0,
      keepWeekly: 4,
      keepMonthly: 6,
      keepYearly: 1,
      minAgeBeforeDeleteMs: 86_400_000n,
    });

    expect(policy).toEqual({
      keepLast: 7,
      keepDaily: 0,
      keepWeekly: 4,
      keepMonthly: 6,
      keepYearly: 1,
      minAgeBeforeDelete: 86_400_000,
    });
    expect(typeof policy.minAgeBeforeDelete).toBe("number");
  });
});

describe("resolveVerifyPlan", () => {
  it("keeps FULL_RESTORE for an UNSCOPED postgres STREAM artifact (its -Fc dump needs no scope)", () => {
    // Postgres is the ONLY engine exempt from the unscoped downgrade: its db-name-agnostic -Fc dump
    // restores into the fixed "verify" sandbox db and the assertion counts all non-system schemas
    // there, so it never hits the system-db collapse the other engines do.
    expect(resolveVerifyPlan("FULL_RESTORE", "postgres", "STREAM", [])).toEqual({
      effectiveLevel: "FULL_RESTORE",
      downgradeReason: null,
    });
  });

  it("keeps FULL_RESTORE for STREAM with no downgrade, for any engine when scoped", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongodb"] as const) {
      expect(resolveVerifyPlan("FULL_RESTORE", engine, "STREAM", ["app"])).toEqual({
        effectiveLevel: "FULL_RESTORE",
        downgradeReason: null,
      });
    }
  });

  it("keeps FULL_RESTORE for a STAGED artifact, which can now be unpacked and restored", () => {
    // Downgrading STAGED to CHECKSUM used to be correct AND dangerous: correct because nothing
    // could restore a directory artifact, dangerous because a CHECKSUM verify passes on the empty
    // artifact STAGED was producing — so an artifact holding no data could reach VERIFIED. With the
    // directory pipeline on both sides, FULL_RESTORE is the honest level again.
    const plan = resolveVerifyPlan("FULL_RESTORE", "postgres", "STAGED", ["app"]);
    expect(plan.effectiveLevel).toBe("FULL_RESTORE");
    expect(plan.downgradeReason).toBeNull();
  });

  it("downgrades an UNSCOPED mysql/mariadb FULL_RESTORE (STREAM) to CHECKSUM — guards the system-db false VERIFIED", () => {
    // C1: originDatabaseFor collapses an unscoped mysql/mariadb origin to the "mysql" SYSTEM db,
    // whose ~30 always-present system tables make the verify table count >= 1 REGARDLESS of whether
    // any user data landed. Downgrade to CHECKSUM rather than mint a false VERIFIED.
    for (const engine of ["mysql", "mariadb"] as const) {
      const plan = resolveVerifyPlan("FULL_RESTORE", engine, "STREAM", []);
      expect(plan.effectiveLevel).toBe("CHECKSUM");
      expect(plan.downgradeReason).toMatch(
        new RegExp(`unscoped ${engine} artifacts cannot be FULL_RESTORE-verified`, "i"),
      );
    }
  });

  it("downgrades an UNSCOPED mongo FULL_RESTORE (STREAM) to CHECKSUM (full-instance archive)", () => {
    const plan = resolveVerifyPlan("FULL_RESTORE", "mongodb", "STREAM", []);
    expect(plan.effectiveLevel).toBe("CHECKSUM");
    expect(plan.downgradeReason).toMatch(
      /unscoped mongodb artifacts cannot be FULL_RESTORE-verified/i,
    );
  });

  it("treats a scope whose first entry is empty as unscoped — consistent with originDatabaseFor (M3)", () => {
    // An empty-string db name is not a real scope entry (targets.ts .min(1) rejects it at the border).
    // resolveVerifyPlan and originDatabaseFor must never disagree: both key off the first NON-EMPTY
    // entry, so [""] and ["", "app"] are unscoped (downgrade → no false VERIFIED), while ["app"] is
    // scoped (keeps FULL_RESTORE). originDatabaseFor("mysql", [""]) === "mysql" pins the same rule.
    for (const scope of [[""], ["", "app"]]) {
      const plan = resolveVerifyPlan("FULL_RESTORE", "mysql", "STREAM", scope);
      expect(plan.effectiveLevel).toBe("CHECKSUM");
      expect(originDatabaseFor("mysql", scope)).toBe("mysql");
    }
    expect(resolveVerifyPlan("FULL_RESTORE", "mysql", "STREAM", ["app"])).toEqual({
      effectiveLevel: "FULL_RESTORE",
      downgradeReason: null,
    });
  });

  it("keeps CHECKSUM unchanged with no downgrade reason regardless of executionMode", () => {
    expect(resolveVerifyPlan("CHECKSUM", "mysql", "STREAM", [])).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: null,
    });
    expect(resolveVerifyPlan("CHECKSUM", "mysql", "STAGED", [])).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: null,
    });
  });

  it("keeps NONE unchanged with no downgrade reason", () => {
    expect(resolveVerifyPlan("NONE", "postgres", "STREAM", [])).toEqual({
      effectiveLevel: "NONE",
      downgradeReason: null,
    });
  });

  it("defaults a missing policy level to CHECKSUM without a downgrade", () => {
    expect(resolveVerifyPlan(null, "postgres", "STREAM", [])).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: null,
    });
  });
});

describe("sourceHasOplogFor", () => {
  const facts = (isReplicaSet: boolean) => ({ isReplicaSet, hasMyisam: false });

  it("records true for a mongo dump of a replica set — the archive carries an oplog", () => {
    // buildDump emits --oplog exactly when it dumps a replica set, and refuses a SCOPED dump there,
    // so reaching this point with isReplicaSet means the archive is full-instance and oplog-bearing.
    expect(sourceHasOplogFor("mongodb", facts(true))).toBe(true);
  });

  it("records false for a mongo dump of a standalone", () => {
    expect(sourceHasOplogFor("mongodb", facts(false))).toBe(false);
  });

  it("records nothing for a non-mongo engine, rather than a misleading false", () => {
    // false would be a claim about an oplog for an engine that has no such concept. Absent is the
    // honest value, and it keeps the column meaning "unknown or not applicable" uniformly.
    expect(sourceHasOplogFor("postgres", facts(false))).toBeUndefined();
    expect(sourceHasOplogFor("mysql", facts(true))).toBeUndefined();
    expect(sourceHasOplogFor("mariadb", facts(false))).toBeUndefined();
  });
});

describe("originDatabaseFor", () => {
  it("returns the first scoped database for every engine when one is scoped", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongodb"] as const) {
      expect(originDatabaseFor(engine, ["app", "reporting"])).toBe("app");
    }
  });

  it("falls back to the engine default the backup used when unscoped", () => {
    expect(originDatabaseFor("postgres", [])).toBe("postgres");
    expect(originDatabaseFor("mysql", [])).toBe("mysql");
    expect(originDatabaseFor("mariadb", [])).toBe("mysql");
    // Unscoped mongo yields the "admin" authSource default (a multi-db archive has no single origin
    // db — a deferred follow-up); a SCOPED mongo target resolves the real data db, unlike
    // probeDatabaseFor which always reports "admin" for mongo.
    expect(originDatabaseFor("mongodb", [])).toBe("admin");
    expect(originDatabaseFor("mongodb", ["events"])).toBe("events");
  });

  it("treats an empty-string first entry as unscoped", () => {
    expect(originDatabaseFor("mysql", [""])).toBe("mysql");
  });
});

describe("verifyEngineWiring", () => {
  it("postgres/mysql/mariadb authenticate against the sandbox database with an empty assertion scope", () => {
    // postgres: sandbox db is the fixed "verify"; mysql/mariadb: sandbox db is the origin db
    // MYSQL_DATABASE pre-created. Either way the assertion reads connection.database, so scope is empty.
    expect(verifyEngineWiring("postgres", "verify", "postgres")).toEqual({
      connectionDatabase: "verify",
      assertionScope: { databases: [], schemas: [], collections: [] },
    });
    expect(verifyEngineWiring("mysql", "app", "app")).toEqual({
      connectionDatabase: "app",
      assertionScope: { databases: [], schemas: [], collections: [] },
    });
    expect(verifyEngineWiring("mariadb", "app", "app")).toEqual({
      connectionDatabase: "app",
      assertionScope: { databases: [], schemas: [], collections: [] },
    });
  });

  it("mongo authenticates against admin (NEVER the origin db) and carries the origin db in the assertion scope", () => {
    // CRITICAL: the root `verify` user lives in admin, so the connection's database MUST be the
    // admin authSource. Putting the origin db there would authenticate against a non-existent user
    // db and fail with the right password. The origin db reaches the assertion through scope instead.
    const wiring = verifyEngineWiring("mongodb", "events", "events");
    expect(wiring.connectionDatabase).toBe("admin");
    expect(wiring.connectionDatabase).not.toBe("events");
    expect(wiring.assertionScope).toEqual({ databases: ["events"], schemas: [], collections: [] });
  });
});

describe("sanitizeReason", () => {
  it("reduces an Error to its name and NEVER echoes the raw message (driver errors embed the URI)", () => {
    const reason = sanitizeReason(
      new Error("mongodb://user:hunter2@db.internal/app connection refused"),
    );
    expect(reason).toBe("job failed: Error");
    expect(reason).not.toContain("hunter2");
    expect(reason).not.toContain("mongodb://");
  });

  it("preserves a custom error class name without its message", () => {
    class ConnRefused extends Error {
      override name = "ConnRefused";
    }
    expect(sanitizeReason(new ConnRefused("password=s3cret"))).toBe("job failed: ConnRefused");
  });

  it("returns the generic reason for a non-Error throw", () => {
    expect(sanitizeReason("password=s3cret literal")).toBe("job failed: unknown error");
    expect(sanitizeReason({ password: "s3cret" })).toBe("job failed: unknown error");
  });
});

describe("toBackupProbe", () => {
  it("sums per-database sizeBytes into estimatedBytes and carries version/scope", () => {
    const rich: EngineProbeResult = {
      serverVersionNum: 160002,
      databases: [
        { name: "app", sizeBytes: 1000 },
        { name: "reporting", sizeBytes: 2500 },
      ],
      scope: { databases: ["app", "reporting"], schemas: [], collections: [] },
      facts: { isReplicaSet: false, hasMyisam: false },
    };
    expect(toBackupProbe(rich)).toEqual({
      serverVersionNum: 160002,
      scope: { databases: ["app", "reporting"], schemas: [], collections: [] },
      estimatedBytes: 3500,
    });
  });

  it("maps an empty database list to zero estimatedBytes", () => {
    const rich: EngineProbeResult = {
      serverVersionNum: 80004,
      databases: [],
      scope: { databases: [], schemas: [], collections: [] },
      facts: { isReplicaSet: false, hasMyisam: false },
    };
    expect(toBackupProbe(rich).estimatedBytes).toBe(0);
  });
});

describe("runVerify org-scoping guard", () => {
  // A minimal env: only the fields createJobExecutor actually reads matter here (no scratch path
  // configured, so no Docker/S3 call is reachable before the guard fires anyway).
  const env = loadEnv({ DATABASE_URL: "postgresql://x/db", SCHRODUMP_KEK: "kek" });

  function fakePrisma(artifact: { organizationId: string }) {
    const backupJobUpdate = vi.fn<
      (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => Promise<Record<string, unknown>>
    >(async () => ({}));
    const artifactUpdate = vi.fn(async () => ({}));
    const encryptionKeyFindMany = vi.fn(async () => []);
    const backupPolicyFindUnique = vi.fn(async () => null);
    const prisma = {
      artifact: {
        findUnique: vi.fn(async () => artifact),
        findUniqueOrThrow: vi.fn(async () => artifact),
        update: artifactUpdate,
      },
      backupJob: { update: backupJobUpdate },
      backupPolicy: { findUnique: backupPolicyFindUnique },
      encryptionKey: { findMany: encryptionKeyFindMany },
    };
    return {
      prisma: prisma as unknown as PrismaClient,
      backupJobUpdate,
      artifactUpdate,
      encryptionKeyFindMany,
      backupPolicyFindUnique,
    };
  }

  // Retention is chained after the same successful backup that enqueues verify, so a policy at its
  // keep limit can prune an older artifact while a verify for it is still queued. findUniqueOrThrow
  // turned that ordinary race into "job failed: PrismaClientKnownRequestError" — an opaque reason
  // for something entirely expected, indistinguishable from a database that broke. Seen in CI.
  it("fails a VERIFY whose artifact was deleted with a reason that says so, not a Prisma error", async () => {
    const { prisma, backupJobUpdate, artifactUpdate } = fakePrisma({ organizationId: "org-mine" });
    (prisma as unknown as { artifact: { findUnique: unknown } }).artifact.findUnique = vi.fn(
      async () => null,
    );
    const executor = createJobExecutor({ prisma, kek: Buffer.alloc(32), audit: { record: () => undefined }, env, log: { warn: () => undefined } });

    await executor.runVerify({
      id: "job-1",
      organizationId: "org-mine",
      kind: "VERIFY",
      policyId: null,
      artifactId: "gone",
      correlationId: "verify:gone",
      restoreParams: null,
    });

    const call = backupJobUpdate.mock.calls[0]![0];
    expect(call.data.state).toBe("FAILED");
    expect(call.data.reason).toBe("the artifact was deleted before this verification could run");
    // Nothing is claimed about an artifact that is not there.
    expect(artifactUpdate).not.toHaveBeenCalled();
  });

  it("fails a mis-scoped VERIFY job LOUD, before any policy lookup or decrypt, and leaves the artifact untouched", async () => {
    const {
      prisma,
      backupJobUpdate,
      artifactUpdate,
      encryptionKeyFindMany,
      backupPolicyFindUnique,
    } = fakePrisma({
      organizationId: "org-other",
    });
    const executor = createJobExecutor({ prisma, kek: Buffer.alloc(32), audit: { record: () => undefined }, env, log: { warn: () => undefined } });
    const job: ClaimedJob = {
      id: "job-1",
      organizationId: "org-mine",
      kind: "VERIFY",
      policyId: null,
      artifactId: "artifact-1",
      correlationId: "verify:artifact-1",
      restoreParams: null,
    };

    await executor.runVerify(job);

    expect(backupJobUpdate).toHaveBeenCalledTimes(1);
    const call = backupJobUpdate.mock.calls[0]![0];
    expect(call.where).toEqual({ id: "job-1" });
    expect(call.data.state).toBe("FAILED");
    const reason = call.data.reason as string;
    // Credential-free: no org id, no secret, just a clear structural reason.
    expect(reason).toBe("verify artifact does not belong to this organization");
    expect(reason).not.toContain("org-other");
    expect(reason).not.toContain("org-mine");

    // The artifact is not ours to judge: its state is never touched on this failure.
    expect(artifactUpdate).not.toHaveBeenCalled();
    // Nothing past the guard ran: no policy lookup, no key material ever fetched/decrypted.
    expect(backupPolicyFindUnique).not.toHaveBeenCalled();
    expect(encryptionKeyFindMany).not.toHaveBeenCalled();
  });
});

describe("createWorkerStore — shutdown signal guards claiming", () => {
  // handle.stop() (shutdown.ts) only halts NEW ticks; the CURRENTLY-RUNNING tick's drainQueue
  // while-loop keeps calling claimNextJob after abort. Without this guard the store would claim —
  // and, against the already-aborted signal, immediately FAIL — every queued PENDING job during the
  // grace window: terminal FAILEDs the scheduler never recreates (it is idempotent by
  // (policyId, scheduledAt)), so those backup cycles would be silently lost. These tests exercise the
  // REAL claimNextJob(prisma) query path through a faked prisma.$queryRaw, not a mocked module, so a
  // regression that lets the guard fall through would actually issue the claim.
  const claimedRow: ClaimedJob = {
    id: "job-1",
    organizationId: "org-1",
    kind: "BACKUP",
    policyId: "policy-1",
    artifactId: null,
    correlationId: "backup:policy-1",
    restoreParams: null,
  };

  function fakePrisma() {
    const queryRaw = vi.fn(async () => [claimedRow]);
    const prisma = { $queryRaw: queryRaw };
    return { prisma: prisma as unknown as PrismaClient, queryRaw };
  }

  it("claims normally when constructed with no signal at all (unchanged behavior outside shutdown)", async () => {
    const { prisma, queryRaw } = fakePrisma();
    const store = createWorkerStore(prisma);

    await expect(store.claimNextJob()).resolves.toEqual(claimedRow);
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("claims normally while the shutdown signal has not tripped", async () => {
    const { prisma, queryRaw } = fakePrisma();
    const controller = new AbortController();
    const store = createWorkerStore(prisma, controller.signal);

    await expect(store.claimNextJob()).resolves.toEqual(claimedRow);
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("claims nothing once the shutdown signal has tripped, and never issues the claim query", async () => {
    const { prisma, queryRaw } = fakePrisma();
    const controller = new AbortController();
    controller.abort();
    const store = createWorkerStore(prisma, controller.signal);

    await expect(store.claimNextJob()).resolves.toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
