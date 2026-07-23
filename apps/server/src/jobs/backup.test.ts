// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  runBackupJob,
  type BackupContext,
  type BackupPorts,
  type Capabilities,
  type ProbeResult,
  type UploadResult,
} from "./backup.js";

const PROBE: ProbeResult = {
  serverVersionNum: 160002,
  scope: { databases: ["app"], schemas: [], collections: [] },
  estimatedBytes: 500,
};

const UPLOAD: UploadResult = {
  bucketKey: "k/artifact.bin",
  manifestKey: "k/manifest.json",
  sizeRawBytes: 500,
  sizeCompressedBytes: 200,
  checksumAlgorithm: "sha256",
  checksum: "abc",
};

const CTX: BackupContext = {
  jobId: "j1",
  organizationId: "o1",
  requestedParallelism: 1,
  stagedThresholdBytes: 1000,
  scratchConfigured: true,
};

interface Harness {
  ports: BackupPorts;
  calls: string[];
  released: { value: boolean };
  persistedStates: string[];
  states: string[];
}

function makeHarness(over: Partial<BackupPorts> = {}, caps?: Capabilities, probe: ProbeResult = PROBE): Harness {
  const calls: string[] = [];
  const released = { value: false };
  const persistedStates: string[] = [];
  const states: string[] = [];
  const ports: BackupPorts = {
    setState: (state) => {
      states.push(state);
      calls.push(`setState:${state}`);
      return Promise.resolve();
    },
    probe: () => {
      calls.push("probe");
      return Promise.resolve(probe);
    },
    capabilities: () => {
      calls.push("capabilities");
      return caps ?? { stagedCapable: true, requiresSeparateGlobalsDump: false };
    },
    reserveScratch: () => {
      calls.push("reserveScratch");
      return Promise.resolve({
        release: () => {
          released.value = true;
          return Promise.resolve();
        },
      });
    },
    resolveRecipients: () => {
      calls.push("resolveRecipients");
      return Promise.resolve({ recipients: ["age1op", "age1esc"], keyIds: ["op", "esc"] });
    },
    executeAndUpload: () => {
      calls.push("executeAndUpload");
      return Promise.resolve(UPLOAD);
    },
    executeGlobals: () => {
      calls.push("executeGlobals");
      return Promise.resolve();
    },
    writeManifest: () => {
      calls.push("writeManifest");
      return Promise.resolve();
    },
    persistArtifact: (input) => {
      calls.push("persistArtifact");
      persistedStates.push(input.state);
      return Promise.resolve("artifact-1");
    },
    ...over,
  };
  return { ports, calls, released, persistedStates, states };
}

describe("runBackupJob", () => {
  it("runs the pipeline in order and persists an UNOBSERVED artifact", async () => {
    const h = makeHarness();
    const outcome = await runBackupJob(CTX, h.ports);
    expect(outcome.ok).toBe(true);
    expect(h.states).toEqual(["RUNNING", "SUCCEEDED"]);
    expect(h.persistedStates).toEqual(["UNOBSERVED"]);
    expect(h.calls).toEqual([
      "setState:RUNNING",
      "probe",
      "capabilities",
      "resolveRecipients",
      "executeAndUpload",
      "writeManifest",
      "persistArtifact",
      "setState:SUCCEEDED",
    ]);
  });

  it("reserves and releases scratch in STAGED mode", async () => {
    const h = makeHarness({}, { stagedCapable: true, requiresSeparateGlobalsDump: false }, {
      ...PROBE,
      estimatedBytes: 5000,
    });
    const outcome = await runBackupJob({ ...CTX, stagedThresholdBytes: 1000 }, h.ports);
    expect(outcome.mode).toBe("STAGED");
    expect(h.calls).toContain("reserveScratch");
    expect(h.released.value).toBe(true);
  });

  it("releases scratch and marks the job FAILED when a mid-pipeline step throws", async () => {
    const h = makeHarness(
      { executeAndUpload: () => Promise.reject(new Error("dump failed")) },
      { stagedCapable: true, requiresSeparateGlobalsDump: false },
      { ...PROBE, estimatedBytes: 5000 },
    );
    const outcome = await runBackupJob({ ...CTX, stagedThresholdBytes: 1000 }, h.ports);
    expect(outcome.ok).toBe(false);
    expect(h.states).toContain("FAILED");
    expect(h.released.value).toBe(true);
  });

  it("runs the postgres globals dump when the capability requires it", async () => {
    const h = makeHarness({}, { stagedCapable: true, requiresSeparateGlobalsDump: true });
    await runBackupJob(CTX, h.ports);
    expect(h.calls).toContain("executeGlobals");
  });

  it("never persists an artifact as VERIFIED — backup only creates UNOBSERVED", async () => {
    const h = makeHarness();
    await runBackupJob(CTX, h.ports);
    for (const state of h.persistedStates) expect(state).not.toBe("VERIFIED");
  });
});
