// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { runVerifyJob, type VerifyContext, type VerifyPorts } from "./verify.js";

interface Harness {
  ports: VerifyPorts;
  artifactStates: string[];
  jobStates: string[];
  // The reason was dropped here for as long as it was dropped in production: a condemned artifact
  // carried a FAILED job with a null reason, and a harness that never looked could not say so.
  jobReasons: (string | undefined)[];
  calls: string[];
}

function makeHarness(over: Partial<VerifyPorts> = {}): Harness {
  const artifactStates: string[] = [];
  const jobStates: string[] = [];
  const jobReasons: (string | undefined)[] = [];
  const calls: string[] = [];
  const ports: VerifyPorts = {
    setJobState: (state, reason) => {
      jobStates.push(state);
      jobReasons.push(reason);
      return Promise.resolve();
    },
    setArtifactState: (state) => {
      artifactStates.push(state);
      return Promise.resolve();
    },
    checksumMatches: () => {
      calls.push("checksumMatches");
      return Promise.resolve(true);
    },
    fullRestore: () => {
      calls.push("fullRestore");
      return Promise.resolve("VERIFIED");
    },
    ...over,
  };
  return { ports, artifactStates, jobStates, jobReasons, calls };
}

const CTX: VerifyContext = {
  jobId: "j1",
  artifactId: "a1",
  verifyLevel: "CHECKSUM",
  sealed: false,
};

describe("runVerifyJob", () => {
  it("promotes the artifact to VERIFIED on a successful checksum verify", async () => {
    const h = makeHarness();
    const outcome = await runVerifyJob(CTX, h.ports);
    expect(outcome.finalState).toBe("VERIFIED");
    expect(h.artifactStates).toEqual(["VERIFIED"]);
  });

  it("marks FAILED and never deletes when verify fails", async () => {
    const h = makeHarness({ checksumMatches: () => Promise.resolve(false) });
    const outcome = await runVerifyJob(CTX, h.ports);
    expect(outcome.finalState).toBe("FAILED");
    expect(h.artifactStates).toEqual(["FAILED"]);
    // no delete port exists — the artifact is preserved
  });

  it("leaves the artifact UNOBSERVED when verify level is NONE", async () => {
    const h = makeHarness();
    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "NONE" }, h.ports);
    expect(outcome.finalState).toBe("UNOBSERVED");
    expect(h.artifactStates).toEqual([]); // never touched — no promotion without verify
  });

  it("runs FULL_RESTORE assertions and promotes to VERIFIED on success", async () => {
    const h = makeHarness();
    await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);
    expect(h.calls).toContain("fullRestore");
    expect(h.artifactStates).toEqual(["VERIFIED"]);
  });

  it("degrades FULL_RESTORE to CHECKSUM on a sealed destination", async () => {
    const h = makeHarness();
    const outcome = await runVerifyJob(
      { ...CTX, verifyLevel: "FULL_RESTORE", sealed: true },
      h.ports,
    );
    expect(outcome.effectiveLevel).toBe("CHECKSUM");
    expect(outcome.degraded).toBe(true);
    expect(h.calls).toContain("checksumMatches");
    expect(h.calls).not.toContain("fullRestore");
  });

  it("marks the artifact FAILED (not deleted) when verify throws", async () => {
    const h = makeHarness({ checksumMatches: () => Promise.reject(new Error("download failed")) });
    const outcome = await runVerifyJob(CTX, h.ports);
    expect(outcome.finalState).toBe("FAILED");
    expect(h.artifactStates).toEqual(["FAILED"]);
  });

  it("marks the artifact FAILED when fullRestore proves it FAILED", async () => {
    const h = makeHarness({ fullRestore: () => Promise.resolve("FAILED") });
    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);
    expect(outcome.finalState).toBe("FAILED");
    expect(h.artifactStates).toEqual(["FAILED"]);
    expect(h.jobStates).toEqual(["RUNNING", "FAILED"]);
  });

  // The job is INCONCLUSIVE, not FAILED: a FAILED job is a process that ran and broke, and this
  // one never got to look. The two were the same row state until the UI had to tell them apart —
  // "could not run" and "the backup is bad" read identically on a jobs list that only had FAILED,
  // and the only way to separate them was to grep the reason string.
  it("leaves the artifact UNOBSERVED and marks the job INCONCLUSIVE when fullRestore is INCONCLUSIVE", async () => {
    const h = makeHarness({ fullRestore: () => Promise.resolve("INCONCLUSIVE") });
    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);
    expect(outcome.finalState).toBe("UNOBSERVED");
    expect(h.artifactStates).toEqual([]); // infra failure never touches the artifact's state
    expect(h.jobStates).toEqual(["RUNNING", "INCONCLUSIVE"]);
    // The reason still says what happened; the state is what a list can filter on.
    expect(h.jobReasons[1]).toMatch(/could not run/);
  });
});

// Condemning an artifact is the most consequential verdict this product issues, and it was issued
// in silence. Observed on a real deployment: two artifacts marked FAILED, their jobs FAILED with a
// null reason, a null exit code and no stderr, and nothing in the log. The verdict was correct —
// the artifacts really were empty — and there was no way to learn how it had been reached.
describe("a verify that condemns an artifact says why", () => {
  it("records why a full restore condemned it", async () => {
    const h = makeHarness({ fullRestore: () => Promise.resolve("FAILED") });

    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);

    expect(outcome.finalState).toBe("FAILED");
    expect(h.artifactStates).toEqual(["FAILED"]);
    expect(h.jobReasons.at(-1)).toMatch(/restored but produced no usable schema/);
  });

  it("records why a checksum condemned it", async () => {
    const h = makeHarness({ checksumMatches: () => Promise.resolve(false) });

    const outcome = await runVerifyJob(CTX, h.ports);

    expect(outcome.finalState).toBe("FAILED");
    expect(h.jobReasons.at(-1)).toMatch(/does not match the checksum in its manifest/);
  });

  it("keeps the downgrade alongside the failure, because they are different claims", async () => {
    // An artifact condemned by a CHECKSUM that only ran because FULL_RESTORE was unavailable is
    // not the same claim as one condemned by a restore. The row has to be able to say which.
    const h = makeHarness({ checksumMatches: () => Promise.resolve(false) });

    await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE", sealed: true }, h.ports);

    expect(h.jobReasons.at(-1)).toMatch(/does not match the checksum/);
    expect(h.jobReasons.at(-1)).toMatch(/sealed destination/);
  });

  it("still says nothing extra when the verify passes", async () => {
    // The reason field is for verdicts an operator has to act on. A clean pass with no downgrade
    // has nothing to add, and filling it would train people to ignore it.
    const h = makeHarness();

    await runVerifyJob(CTX, h.ports);

    expect(h.jobStates.at(-1)).toBe("SUCCEEDED");
    expect(h.jobReasons.at(-1)).toBeUndefined();
  });
});
