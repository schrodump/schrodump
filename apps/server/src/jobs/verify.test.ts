// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { runVerifyJob, type VerifyContext, type VerifyPorts } from "./verify.js";

interface Harness {
  ports: VerifyPorts;
  artifactStates: string[];
  jobStates: string[];
  calls: string[];
}

function makeHarness(over: Partial<VerifyPorts> = {}): Harness {
  const artifactStates: string[] = [];
  const jobStates: string[] = [];
  const calls: string[] = [];
  const ports: VerifyPorts = {
    setJobState: (state) => {
      jobStates.push(state);
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
      return Promise.resolve(true);
    },
    ...over,
  };
  return { ports, artifactStates, jobStates, calls };
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
    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE", sealed: true }, h.ports);
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
});
