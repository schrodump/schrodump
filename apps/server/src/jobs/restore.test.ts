// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { EncryptionKeyRecord } from "../crypto/artifact.js";
import {
  dumpIsMultiDatabaseFor,
  runRestoreJob,
  type ArtifactForRestore,
  type RestorePorts,
  type RestoreRequest,
} from "./restore.js";

const REQ: RestoreRequest = {
  jobId: "j1",
  artifactId: "a1",
  organizationId: "o1",
  userId: "u1",
  target: "DATABASE",
  confirmExistingDatabase: false,
};

const ARTIFACT: ArtifactForRestore = {
  manifestKeyIds: ["retired-op", "escrow"],
  engine: "postgres",
  executionMode: "STREAM",
  supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE", "SCHEMA", "TABLE"],
  destinationName: "prod-s3",
};

// A now-retired operational key that the artifact was encrypted with; the server still holds it.
const KEYS: EncryptionKeyRecord[] = [
  { keyId: "retired-op", type: "operational", publicRecipient: "age1old", state: "retired" },
  { keyId: "escrow", type: "escrow", publicRecipient: "age1esc", state: "active" },
];

interface Harness {
  ports: RestorePorts;
  audits: unknown[];
  jobStates: string[];
  jobReasons: (string | undefined)[];
  restoredWithKey: string[];
}

function makeHarness(over: Partial<RestorePorts> = {}, existingData = false): Harness {
  const audits: unknown[] = [];
  const jobStates: string[] = [];
  const jobReasons: (string | undefined)[] = [];
  const restoredWithKey: string[] = [];
  const ports: RestorePorts = {
    loadArtifact: () => Promise.resolve(ARTIFACT),
    availableKeys: () => Promise.resolve(KEYS),
    targetHasExistingData: () => Promise.resolve(existingData),
    audit: (event) => {
      audits.push(event);
      return Promise.resolve();
    },
    setJobState: (state, reason) => {
      jobStates.push(state);
      jobReasons.push(reason);
      return Promise.resolve();
    },
    runRestore: (keyId) => {
      restoredWithKey.push(keyId);
      return Promise.resolve(true);
    },
    ...over,
  };
  return { ports, audits, jobStates, jobReasons, restoredWithKey };
}

describe("runRestoreJob — oplog provenance caveat", () => {
  const mongo = (over: Partial<ArtifactForRestore> = {}): ArtifactForRestore => ({
    ...ARTIFACT,
    engine: "mongodb",
    supportedRestoreTargets: ["FULL_CLUSTER"],
    ...over,
  });
  const fullCluster: RestoreRequest = { ...REQ, target: "FULL_CLUSTER" };

  it("records the consistency caveat when the archive's provenance is unknown", async () => {
    // An artifact written before the fact was tracked. The restore still happens — refusing it
    // would strand the operator mid-incident — but it must not happen silently: without oplog
    // replay each collection lands on a slightly different instant.
    const h = makeHarness({ loadArtifact: () => Promise.resolve(mongo()) });
    const outcome = await runRestoreJob(fullCluster, h.ports);
    expect(outcome.ok).toBe(true);
    expect(h.jobStates).toEqual(["RUNNING", "SUCCEEDED"]);
    expect(h.jobReasons[1]).toMatch(/oplog/i);
  });

  it("stays silent when the archive is known to carry an oplog — it was replayed", async () => {
    const h = makeHarness({
      loadArtifact: () => Promise.resolve(mongo({ sourceHasOplog: true })),
    });
    await runRestoreJob(fullCluster, h.ports);
    expect(h.jobReasons[1]).toBeUndefined();
  });

  it("stays silent when the archive is known to carry no oplog — there was nothing to replay", async () => {
    const h = makeHarness({
      loadArtifact: () => Promise.resolve(mongo({ sourceHasOplog: false })),
    });
    await runRestoreJob(fullCluster, h.ports);
    expect(h.jobReasons[1]).toBeUndefined();
  });

  it("stays silent for a non-mongo engine, which has no oplog to speak of", async () => {
    const h = makeHarness();
    await runRestoreJob({ ...REQ, target: "FULL_CLUSTER" }, h.ports);
    expect(h.jobReasons[1]).toBeUndefined();
  });
});

describe("runRestoreJob", () => {
  it("restores using a retired key resolved from the manifest, and audits it", async () => {
    const h = makeHarness();
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.ok).toBe(true);
    expect(outcome.keyId).toBe("retired-op");
    expect(h.restoredWithKey).toEqual(["retired-op"]);
    expect(h.audits).toHaveLength(1);
  });

  it("refuses a restore target the artifact does not support", async () => {
    const h = makeHarness();
    const outcome = await runRestoreJob({ ...REQ, target: "COLLECTION" }, h.ports);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not supported/i);
    expect(h.restoredWithKey).toEqual([]);
  });

  it("passes the STREAM gate for a non-postgres engine, reaching the target-matrix check", async () => {
    // The gate is executionMode, not engine: a STREAM mysql/mongodb artifact is no longer refused up
    // front. It still has to clear the target-matrix check like any other artifact.
    const h = makeHarness({
      loadArtifact: () =>
        Promise.resolve({
          ...ARTIFACT,
          engine: "mongodb",
          executionMode: "STREAM",
          supportedRestoreTargets: ["DATABASE"],
        }),
    });
    const outcome = await runRestoreJob({ ...REQ, target: "COLLECTION" }, h.ports);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not supported/i);
    expect(h.restoredWithKey).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("restores a STAGED artifact now that the directory pipeline exists", async () => {
    // The refusal here was the second half of the STAGED hole: the backup side uploaded an empty
    // artifact, and this gate meant nothing could ever try to restore one and notice. Both sides
    // land together — buildArchiveStaging on the way out, buildExtractStaging on the way back.
    const h = makeHarness({
      loadArtifact: () => Promise.resolve({ ...ARTIFACT, executionMode: "STAGED" as const }),
    });
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.ok).toBe(true);
    expect(h.jobStates).toEqual(["RUNNING", "SUCCEEDED"]);
  });

  it("refuses to restore over existing data without explicit confirmation", async () => {
    const h = makeHarness({}, true);
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/confirmation/i);
    expect(h.restoredWithKey).toEqual([]);
  });

  it("proceeds when restoring over existing data is explicitly confirmed", async () => {
    const h = makeHarness({}, true);
    const outcome = await runRestoreJob({ ...REQ, confirmExistingDatabase: true }, h.ports);
    expect(outcome.ok).toBe(true);
    expect(h.restoredWithKey).toEqual(["retired-op"]);
  });

  it("fails clearly when no server-held key matches (sealed artifact)", async () => {
    const h = makeHarness({
      availableKeys: () => Promise.resolve([KEYS[1] as EncryptionKeyRecord]), // escrow only
    });
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/sealed|identity/i);
  });
});

// A mysqldump script carries CREATE DATABASE / USE / DROP TABLE for every database it was dumped
// with, and mysql's buildRestore emits no scoping flag at all — FULL_CLUSTER and DATABASE produce
// the IDENTICAL command. So a DATABASE restore of a multi-database artifact is a claim with no
// mechanism behind it. Measured on mysql 8.4.10, not inferred: two databases dumped together, a row
// added to the second after the dump, the script restored "into" the first — the second went from
// two rows to one, the new row gone, and the client exited 0.
describe("runRestoreJob — a mysql dump script cannot be confined to one database", () => {
  const sql = (over: Partial<ArtifactForRestore> = {}): ArtifactForRestore => ({
    ...ARTIFACT,
    engine: "mysql",
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE"],
    ...over,
  });

  it.each(["mysql", "mariadb"])(
    "refuses a DATABASE restore of a multi-database %s artifact",
    async (engine) => {
      const h = makeHarness({
        loadArtifact: () => Promise.resolve(sql({ engine, dumpIsMultiDatabase: true })),
      });
      const outcome = await runRestoreJob(REQ, h.ports);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/cannot be confined/i);
      expect(h.restoredWithKey).toEqual([]);
      // Refused before the audit, like every other pre-flight check: nothing was attempted.
      expect(h.audits).toEqual([]);
    },
  );

  it("names FULL_CLUSTER as the honest way to run it anyway", async () => {
    // The refusal costs the operator nothing but the false claim: for mysql the two targets build
    // the same command, so FULL_CLUSTER does exactly what a DATABASE restore was already doing —
    // it just says so.
    const h = makeHarness({
      loadArtifact: () => Promise.resolve(sql({ dumpIsMultiDatabase: true })),
    });
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.error).toMatch(/FULL_CLUSTER/);
  });

  it("refuses when the artifact predates the fact being recorded", async () => {
    // undefined is a weaker claim than false, and the failure direction decides the answer:
    // permitting the hazard silently costs a neighbouring database, while refusing costs a label.
    // A catalog rebuild recovers the fact from the manifest already in the bucket.
    const h = makeHarness({ loadArtifact: () => Promise.resolve(sql()) });
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/never recorded/i);
    expect(h.restoredWithKey).toEqual([]);
  });

  it("allows a DATABASE restore when the artifact is recorded single-database", async () => {
    const h = makeHarness({
      loadArtifact: () => Promise.resolve(sql({ dumpIsMultiDatabase: false })),
    });
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.ok).toBe(true);
    expect(h.restoredWithKey).toEqual(["retired-op"]);
  });

  it("allows FULL_CLUSTER of a multi-database artifact — the whole script is what was asked for", async () => {
    const h = makeHarness({
      loadArtifact: () => Promise.resolve(sql({ dumpIsMultiDatabase: true })),
    });
    const outcome = await runRestoreJob({ ...REQ, target: "FULL_CLUSTER" }, h.ports);
    expect(outcome.ok).toBe(true);
    expect(h.restoredWithKey).toEqual(["retired-op"]);
  });

  it("leaves postgres alone: a pg_dump artifact is one database whatever the target scope said", async () => {
    const h = makeHarness({ loadArtifact: () => Promise.resolve(ARTIFACT) });
    const outcome = await runRestoreJob(REQ, h.ports);
    expect(outcome.ok).toBe(true);
  });
});

describe("dumpIsMultiDatabaseFor", () => {
  it("says nothing about engines whose restore is not a replayed script", () => {
    // false would assert something about a mysqldump script for artifacts that have none, and the
    // stored value would stop meaning what it says.
    expect(dumpIsMultiDatabaseFor("postgres", "STREAM", ["a", "b"])).toBeUndefined();
    expect(dumpIsMultiDatabaseFor("mongodb", "STREAM", ["a", "b"])).toBeUndefined();
  });

  it("is false for a STREAM dump that named at most one database", () => {
    // No --databases at all (the dump takes the connection's own database), and --databases with a
    // single name: both scripts land in exactly one place.
    expect(dumpIsMultiDatabaseFor("mysql", "STREAM", [])).toBe(false);
    expect(dumpIsMultiDatabaseFor("mysql", "STREAM", ["app"])).toBe(false);
  });

  it("is true for a STREAM dump that named two or more databases", () => {
    expect(dumpIsMultiDatabaseFor("mysql", "STREAM", ["app", "billing"])).toBe(true);
    expect(dumpIsMultiDatabaseFor("mariadb", "STREAM", ["app", "billing", "analytics"])).toBe(true);
  });

  it("is false for a STAGED artifact whatever the scope listed", () => {
    // STAGED is mydumper, and `mydumper -B <db>` dumps ONE database — myloader restores it into one
    // with the same flag. A staged artifact is single-database by construction, so refusing a
    // DATABASE restore of one would cost a capability that actually works.
    expect(dumpIsMultiDatabaseFor("mysql", "STAGED", ["app", "billing"])).toBe(false);
  });
});
