// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { EncryptionKeyRecord } from "../crypto/artifact.js";
import {
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
