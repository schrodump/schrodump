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
  restoredWithKey: string[];
}

function makeHarness(over: Partial<RestorePorts> = {}, existingData = false): Harness {
  const audits: unknown[] = [];
  const jobStates: string[] = [];
  const restoredWithKey: string[] = [];
  const ports: RestorePorts = {
    loadArtifact: () => Promise.resolve(ARTIFACT),
    availableKeys: () => Promise.resolve(KEYS),
    targetHasExistingData: () => Promise.resolve(existingData),
    audit: (event) => {
      audits.push(event);
      return Promise.resolve();
    },
    setJobState: (state) => {
      jobStates.push(state);
      return Promise.resolve();
    },
    runRestore: (keyId) => {
      restoredWithKey.push(keyId);
      return Promise.resolve(true);
    },
    ...over,
  };
  return { ports, audits, jobStates, restoredWithKey };
}

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
