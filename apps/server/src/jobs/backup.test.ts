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
  singleDatabaseStagingScope: null,
  stagedTlsRefusal: null,
};

interface Harness {
  ports: BackupPorts;
  calls: string[];
  released: { value: boolean };
  persistedStates: string[];
  states: string[];
  reasons: (string | undefined)[];
}

function makeHarness(
  over: Partial<BackupPorts> = {},
  caps?: Capabilities,
  probe: ProbeResult = PROBE,
): Harness {
  const calls: string[] = [];
  const released = { value: false };
  const persistedStates: string[] = [];
  const states: string[] = [];
  const reasons: (string | undefined)[] = [];
  const ports: BackupPorts = {
    setState: (state, reason) => {
      states.push(state);
      reasons.push(reason);
      calls.push(`setState:${state}`);
      return Promise.resolve();
    },
    probe: () => {
      calls.push("probe");
      return Promise.resolve(probe);
    },
    capabilities: () => {
      calls.push("capabilities");
      return caps ?? { stagedCapable: true, maxParallelism: 8, requiresSeparateGlobalsDump: false };
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
    discardObjects: () => {
      calls.push("discardObjects");
      return Promise.resolve();
    },
    ...over,
  };
  return { ports, calls, released, persistedStates, states, reasons };
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

  // A degradation nobody can read is a silent one. The TLS reroute is the case that matters here: a
  // policy asking for a staged dump of a TLS target without a CA gets a stream, and the job says why.
  it("writes an execution-mode degradation as the SUCCEEDED job's reason", async () => {
    const reasons: Array<string | undefined> = [];
    const h = makeHarness({
      setState: (state, reason) => {
        if (state === "SUCCEEDED") reasons.push(reason);
        return Promise.resolve();
      },
    });
    const refusal = "mydumper cannot require TLS without verifying it";
    const outcome = await runBackupJob(
      { ...CTX, requestedParallelism: 4, stagedTlsRefusal: refusal },
      h.ports,
    );
    expect(outcome.mode).toBe("STREAM");
    expect(reasons).toEqual([
      `staged unavailable: ${refusal}, and this TLS target has no CA certificate — streamed instead`,
    ]);
    // And nothing was reserved for a STAGED dump that did not happen.
    expect(h.calls).not.toContain("reserveScratch");
  });

  it("writes no reason on a SUCCEEDED job that degraded nothing", async () => {
    const reasons: Array<string | undefined> = [];
    const h = makeHarness({
      setState: (state, reason) => {
        if (state === "SUCCEEDED") reasons.push(reason);
        return Promise.resolve();
      },
    });
    await runBackupJob(CTX, h.ports);
    expect(reasons).toEqual([undefined]);
  });

  // The scratch reserve/release lifecycle used to be covered here through STAGED mode. STAGED is
  // now unreachable on purpose (see resolveExecutionMode: a staged dump uploaded an EMPTY artifact
  // while reporting SUCCEEDED), so nothing in runBackupJob reserves scratch any more and there is
  // no honest way to exercise that branch from here. The branch is kept for the directory pipeline
  // that will restore it; this comment is the marker that its coverage went with STAGED.

  it("marks the job FAILED when a mid-pipeline step throws", async () => {
    const h = makeHarness(
      { executeAndUpload: () => Promise.reject(new Error("dump failed")) },
      { stagedCapable: true, maxParallelism: 8, requiresSeparateGlobalsDump: false },
      { ...PROBE, estimatedBytes: 5000 },
    );
    const outcome = await runBackupJob({ ...CTX, stagedThresholdBytes: 1000 }, h.ports);
    expect(outcome.ok).toBe(false);
    expect(h.states).toContain("FAILED");
  });

  it("runs the postgres globals dump when the capability requires it", async () => {
    const h = makeHarness({}, { stagedCapable: true, maxParallelism: 8, requiresSeparateGlobalsDump: true });
    await runBackupJob(CTX, h.ports);
    expect(h.calls).toContain("executeGlobals");
  });

  it("never persists an artifact as VERIFIED — backup only creates UNOBSERVED", async () => {
    const h = makeHarness();
    await runBackupJob(CTX, h.ports);
    for (const state of h.persistedStates) expect(state).not.toBe("VERIFIED");
  });

  // The mode's warnings were returned in the outcome and read by nobody: a policy asking for
  // parallelism 4 over an unscoped mysql target streamed at 1, and nothing anywhere said why.
  it("writes an execution-mode degradation onto the SUCCEEDED job", async () => {
    const reasons: (string | undefined)[] = [];
    const h = makeHarness({
      setState: (state, reason) => {
        if (state === "SUCCEEDED") reasons.push(reason);
        return Promise.resolve();
      },
    });

    const outcome = await runBackupJob(
      { ...CTX, requestedParallelism: 4, singleDatabaseStagingScope: [] },
      h.ports,
    );

    expect(outcome.mode).toBe("STREAM");
    expect(reasons).toEqual([
      "staged unavailable: mydumper dumps a single database and this target is unscoped — streamed instead",
    ]);
  });

  it("leaves the SUCCEEDED job without a reason when nothing degraded", async () => {
    const reasons: (string | undefined)[] = [];
    const h = makeHarness({
      setState: (state, reason) => {
        if (state === "SUCCEEDED") reasons.push(reason);
        return Promise.resolve();
      },
    });

    await runBackupJob(CTX, h.ports);

    expect(reasons).toEqual([undefined]);
  });
});

// Every step after the upload can fail, and none of them used to clean up after the one before it.
// A postgres globals dump refused by a managed server left the database dump in the bucket with no
// manifest and no row — nothing that could ever find it again. The objects belong to a row, and
// until the row exists they belong to nobody.
describe("runBackupJob — a failure before the row exists leaves nothing in the bucket", () => {
  const POSTGRES_CAPS: Capabilities = {
    stagedCapable: true,
    maxParallelism: 8,
    requiresSeparateGlobalsDump: true,
  };

  const refused = (message: string) => () => Promise.reject(new Error(message));
  const STEPS: [string, Partial<BackupPorts>][] = [
    [
      "the globals dump",
      {
        executeGlobals: refused(
          "globals dump execution failed (exit code 1): permission denied for table pg_authid",
        ),
      },
    ],
    ["the manifest write", { writeManifest: refused("put failed: manifest") }],
    ["the row insert", { persistArtifact: refused("insert failed") }],
  ];

  // ...and the step's own failure stays the reason.
  it.each(STEPS)("discards what was written when %s fails", async (_step, over) => {
    const h = makeHarness(over, POSTGRES_CAPS);
    const outcome = await runBackupJob(CTX, h.ports);

    expect(outcome.ok).toBe(false);
    expect(h.calls).toContain("discardObjects");
    // Discarded BEFORE the job is closed: a FAILED job whose objects are still being deleted is a
    // window in which the bucket and the ledger disagree.
    expect(h.calls.indexOf("discardObjects")).toBeLessThan(h.calls.indexOf("setState:FAILED"));
    expect(h.persistedStates).toEqual([]);
    // The reason is the step's own failure, not a word about cleanup.
    const reason = h.reasons[h.states.indexOf("FAILED")];
    expect(reason).not.toMatch(/could not be removed/);
    expect(reason?.length).toBeGreaterThan(0);
  });

  it("says so in the reason when the objects could not be removed, without losing the cause", async () => {
    const h = makeHarness(
      {
        executeGlobals: refused("globals dump execution failed (exit code 1)"),
        discardObjects: refused("DeleteObjects: 503"),
      },
      POSTGRES_CAPS,
    );
    await runBackupJob(CTX, h.ports);

    const reason = h.reasons[h.states.indexOf("FAILED")] ?? "";
    expect(reason.startsWith("globals dump execution failed (exit code 1)")).toBe(true);
    expect(reason).toMatch(/could not be removed/);
  });

  // The other direction, and the more dangerous one: once the row exists the objects ARE the
  // artifact. Deleting them because a later bookkeeping write failed would leave a row that points
  // at nothing — a backup the catalog promises and the bucket does not hold.
  it("never discards the objects of an artifact whose row was written", async () => {
    let first = true;
    const h = makeHarness(
      {
        setState: (state) => {
          if (state === "SUCCEEDED" && first) {
            first = false;
            return Promise.reject(new Error("the job row could not be updated"));
          }
          return Promise.resolve();
        },
      },
      POSTGRES_CAPS,
    );
    await runBackupJob(CTX, h.ports);

    expect(h.calls).toContain("persistArtifact");
    expect(h.calls).not.toContain("discardObjects");
  });
});
