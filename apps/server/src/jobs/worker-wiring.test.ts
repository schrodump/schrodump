// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ProbeResult as EngineProbeResult } from "@schrodump/engines/probe/types";
import {
  EngineDescriptorError,
  type TargetConnection,
  type TargetFacts,
} from "@schrodump/engines/descriptor";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import { loadEnv } from "../env.js";
import {
  buildDumpDescriptorFor,
  createJobExecutor,
  createWorkerStore,
  originDatabaseFor,
  postgresUnscopedAlternatives,
  resolveVerifyPlan,
  verifiedProvenance,
  sanitizeReason,
  sourceHasOplogFor,
  toBackupProbe,
  toRetentionPolicy,
  dumpScopeFor,
  verifyEngineWiring,
  VERIFY_INCONCLUSIVE_LOG,
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

describe("verifiedProvenance", () => {
  it("records a real full restore as an undegraded FULL_RESTORE", () => {
    expect(
      verifiedProvenance({ finalState: "VERIFIED", effectiveLevel: "FULL_RESTORE", degraded: false }, false),
    ).toEqual({ verifiedLevel: "FULL_RESTORE", verifiedDegraded: false });
  });

  it("marks degraded when resolveVerifyPlan downgraded the level (unscoped/STAGED)", () => {
    // The plan-level downgrade (an unscoped replica-set dump) is invisible to runVerifyJob — it was
    // handed CHECKSUM as the requested level — so the flag has to come from planDowngraded here.
    expect(
      verifiedProvenance({ finalState: "VERIFIED", effectiveLevel: "CHECKSUM", degraded: false }, true),
    ).toEqual({ verifiedLevel: "CHECKSUM", verifiedDegraded: true });
  });

  it("marks degraded when runVerifyJob itself downgraded (sealed destination)", () => {
    expect(
      verifiedProvenance({ finalState: "VERIFIED", effectiveLevel: "CHECKSUM", degraded: true }, false),
    ).toEqual({ verifiedLevel: "CHECKSUM", verifiedDegraded: true });
  });

  it("records the level for a FAILED artifact too — a checksum condemnation differs from a restore one", () => {
    expect(
      verifiedProvenance({ finalState: "FAILED", effectiveLevel: "CHECKSUM", degraded: false }, false),
    ).toEqual({ verifiedLevel: "CHECKSUM", verifiedDegraded: false });
  });

  it("returns null when the verify left the artifact untouched (UNOBSERVED) — nothing to record", () => {
    // The gate: an INCONCLUSIVE FULL_RESTORE or a NONE level never called setArtifactState, so this
    // must not write a level over whatever a prior verify left. Drop the gate and this returns a
    // value, overwriting a genuine prior verdict's provenance.
    expect(
      verifiedProvenance({ finalState: "UNOBSERVED", effectiveLevel: "FULL_RESTORE", degraded: false }, false),
    ).toBeNull();
    expect(
      verifiedProvenance({ finalState: "UNOBSERVED", effectiveLevel: "NONE", degraded: false }, true),
    ).toBeNull();
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

// The mongo dump scope comes from the TARGET, not from what the probe happened to discover.
//
// probeMongodb lists every database the credential can see. Feeding that into buildDump made
// `scoped` true for every credential, and buildDump refuses `isReplicaSet && scoped` — so NO
// replica set could be backed up, and --oplog / sourceHasOplog / --oplogReplay were unreachable.
describe("dumpScopeFor", () => {
  const probeFound = { databases: ["admin", "config", "local", "shop"], schemas: [], collections: [] };

  it("gives mongodb an EMPTY scope for an unscoped target, which is what --oplog requires", () => {
    expect(dumpScopeFor("mongodb", probeFound, [])).toEqual({
      databases: [],
      schemas: [],
      collections: [],
    });
  });

  it("still narrows mongodb to a scoped target", () => {
    expect(dumpScopeFor("mongodb", probeFound, ["shop"])).toEqual({
      databases: ["shop"],
      schemas: [],
      collections: [],
    });
  });

  it("leaves the SQL engines reading the probe, where scope is discovery rather than intent", () => {
    for (const engine of ["postgres", "mysql", "mariadb"] as const) {
      expect(dumpScopeFor(engine, probeFound, [])).toBe(probeFound);
      expect(dumpScopeFor(engine, probeFound, ["ignored"])).toBe(probeFound);
    }
  });
});

describe("VERIFY_INCONCLUSIVE_LOG", () => {
  it("is still the text scripts/smoke-compose.sh goes looking for", () => {
    // These two live in different files and different languages, and only one of them can be read
    // by the compiler. A verify that could not run leaves its cause in the container log and
    // nowhere else; by the time a smoke step gives up, that line has scrolled out of the forty
    // it prints, so the script greps for it by name. Reword the message here and not there and
    // the grep matches nothing — the cause is silently gone again, which is the regression the
    // log call itself exists to prevent. So the pattern is read out of the script rather than
    // restated here, where it could drift in step with the mistake.
    const script = readFileSync(new URL("../../../../scripts/smoke-compose.sh", import.meta.url), "utf8");
    const pattern = script.match(/grep -F '([^']*verify inconclusive[^']*)'/)?.[1];

    expect(pattern, "smoke-compose.sh no longer greps for an inconclusive verify").toBeDefined();
    expect(VERIFY_INCONCLUSIVE_LOG).toContain(pattern);
  });
});

// On a real deployment an unscoped postgres target backed up `postgres` — the maintenance database,
// 7.5 MB of catalogs — while `ipog_finance`, 9.4 GB, sat beside it untouched. The job was SUCCEEDED,
// the artifact was 876 bytes, and the row said "9.4 GB" because sizeRawBytes was the probe's
// server-wide estimate. Only a FULL_RESTORE verify caught it; the default CHECKSUM would not have.
describe("postgresUnscopedAlternatives", () => {
  const found = ["ipog_finance", "postgres"];

  it("names the databases an unscoped postgres target would silently leave behind", () => {
    expect(postgresUnscopedAlternatives("postgres", [], "postgres", found)).toEqual(["ipog_finance"]);
  });

  it("is empty when the maintenance database is the only one, because then it is where the data lives", () => {
    expect(postgresUnscopedAlternatives("postgres", [], "postgres", ["postgres"])).toEqual([]);
  });

  it("never second-guesses an explicit scope", () => {
    expect(postgresUnscopedAlternatives("postgres", ["ipog_finance"], "ipog_finance", found)).toEqual([]);
  });

  it("respects an explicit `postgres` too — naming it is a decision, defaulting to it is not", () => {
    expect(postgresUnscopedAlternatives("postgres", ["postgres"], "postgres", found)).toEqual([]);
  });

  it("treats an empty-string scope entry as unscoped, the same way originDatabaseFor does", () => {
    expect(postgresUnscopedAlternatives("postgres", [""], "postgres", found)).toEqual(["ipog_finance"]);
  });

  it("stays out of the other engines, whose dump tools copy everything the probe found", () => {
    for (const engine of ["mysql", "mariadb", "mongodb"] as const) {
      expect(postgresUnscopedAlternatives(engine, [], "mysql", ["a", "b", "mysql"])).toEqual([]);
    }
  });
});

describe("buildDumpDescriptorFor", () => {
  const connection = (database: string): TargetConnection => ({
    host: "db",
    port: 5432,
    database,
    username: "app",
    password: "pw",
    tls: false,
  });
  const facts: TargetFacts = { isReplicaSet: false, hasMyisam: false };
  const probe = (databases: string[]) => ({
    serverVersionNum: 170_011,
    scope: { databases, schemas: [], collections: [] },
    estimatedBytes: 9_446_000_000,
  });
  // Records what reached the adapter, so a test can assert that nothing did.
  function recordingAdapter() {
    const calls: unknown[] = [];
    const adapter = {
      buildDump: (input: unknown): ExecutionDescriptor => {
        calls.push(input);
        return { image: "postgres:17", command: ["pg_dump"], env: {}, outputKind: "stdout" };
      },
    };
    return { adapter, calls };
  }

  it("refuses the incident exactly, before any descriptor is built", () => {
    const { adapter, calls } = recordingAdapter();
    const build = buildDumpDescriptorFor({
      adapter,
      engine: "postgres",
      connection: connection("postgres"),
      scopedDatabases: [],
      facts,
      stagingPathFor: () => undefined,
    });

    let thrown: unknown;
    try {
      build("STREAM", 1, probe(["ipog_finance", "postgres"]));
    } catch (error) {
      thrown = error;
    }

    // EngineDescriptorError specifically: it is the class whose message backup.ts writes verbatim
    // into BackupJob.reason. A plain Error would be sanitized to "job failed: Error" and leave the
    // operator exactly as uninformed as the silent default did.
    expect(thrown).toBeInstanceOf(EngineDescriptorError);
    expect((thrown as EngineDescriptorError).code).toBe("POSTGRES_SCOPE_REQUIRED");
    expect((thrown as Error).message).toMatch(/ipog_finance/);
    expect((thrown as Error).message).toMatch(/maintenance database/);
    expect((thrown as Error).message).toMatch(/scope/);
    expect(calls).toHaveLength(0);
  });

  it("builds the descriptor for a scoped target, with the probe scope SQL engines dump under", () => {
    const { adapter, calls } = recordingAdapter();
    const build = buildDumpDescriptorFor({
      adapter,
      engine: "postgres",
      connection: connection("ipog_finance"),
      scopedDatabases: ["ipog_finance"],
      facts,
      stagingPathFor: () => "/scratch/job-1",
    });
    const found = probe(["ipog_finance", "postgres"]);

    build("STREAM", 1, found);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      connection: connection("ipog_finance"),
      executionMode: "STREAM",
      parallelism: 1,
      scope: found.scope,
      facts,
    });
    expect(calls[0]).not.toHaveProperty("stagingPath");
  });

  it("hands STAGED its staging path and STREAM none", () => {
    const { adapter, calls } = recordingAdapter();
    const build = buildDumpDescriptorFor({
      adapter,
      engine: "postgres",
      connection: connection("ipog_finance"),
      scopedDatabases: ["ipog_finance"],
      facts,
      stagingPathFor: () => "/scratch/job-1",
    });

    build("STAGED", 4, probe(["ipog_finance"]));

    expect(calls[0]).toMatchObject({ executionMode: "STAGED", parallelism: 4, stagingPath: "/scratch/job-1" });
  });

  it("lets an unscoped postgres target through when the server holds nothing else", () => {
    const { adapter, calls } = recordingAdapter();
    const build = buildDumpDescriptorFor({
      adapter,
      engine: "postgres",
      connection: connection("postgres"),
      scopedDatabases: [],
      facts,
      stagingPathFor: () => undefined,
    });

    build("STREAM", 1, probe(["postgres"]));

    expect(calls).toHaveLength(1);
  });

  it("does not refuse mysql, whose dump copies every database the probe found", () => {
    const { adapter, calls } = recordingAdapter();
    const build = buildDumpDescriptorFor({
      adapter,
      engine: "mysql",
      connection: connection("mysql"),
      scopedDatabases: [],
      facts,
      stagingPathFor: () => undefined,
    });

    build("STREAM", 1, probe(["shop", "billing", "mysql"]));

    expect(calls).toHaveLength(1);
  });
});
