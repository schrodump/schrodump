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
    compareChecksum: () => {
      calls.push("compareChecksum");
      return Promise.resolve({ proof: "MATCHED" as const, cause: null });
    },
    fullRestore: () => {
      calls.push("fullRestore");
      return Promise.resolve({ proof: "VERIFIED", cause: null });
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
    const h = makeHarness({ compareChecksum: () => Promise.resolve({ proof: "MISMATCHED" as const, cause: null }) });
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
    expect(h.calls).toContain("compareChecksum");
    expect(h.calls).not.toContain("fullRestore");
  });

  // The defect: `checksumMatches` streamed the object inside the try, so a 503 from the bucket, a
  // reset socket or an expired credential fell into the catch and marked the artifact FAILED. It
  // condemned a backup because we could not look at it, fired ARTIFACT_FAILED, and invited the
  // operator to delete the copy that was fine — the product's central claim, made backwards.
  it("leaves the artifact alone when the object could not be READ, and says the check did not run", async () => {
    const h = makeHarness({
      compareChecksum: () =>
        Promise.resolve({ proof: "INCONCLUSIVE" as const, cause: "s3 get failed: TimeoutError" }),
    });
    const outcome = await runVerifyJob(CTX, h.ports);
    expect(outcome.finalState).toBe("UNCHANGED");
    // Not touched at all: an artifact a previous verify proved good stays VERIFIED.
    expect(h.artifactStates).toEqual([]);
    expect(h.jobStates).toEqual(["RUNNING", "INCONCLUSIVE"]);
    expect(h.jobReasons.at(-1)).toContain("TimeoutError");
    expect(h.jobReasons.at(-1)).toContain("artifact unchanged");
  });

  // An object that is GONE is a verdict — there is no backup at that key.
  it("condemns the artifact when the bytes are not what the manifest recorded", async () => {
    const h = makeHarness({
      compareChecksum: () =>
        Promise.resolve({
          proof: "MISMATCHED" as const,
          cause: "the stored object is not in the bucket",
        }),
    });
    const outcome = await runVerifyJob(CTX, h.ports);
    expect(outcome.finalState).toBe("FAILED");
    expect(h.artifactStates).toEqual(["FAILED"]);
    expect(h.jobReasons.at(-1)).toContain("not in the bucket");
  });

  // A port that rejects is OUR machinery, and every verdict path above has already set the
  // artifact explicitly. This used to mark it FAILED — so a database blip in `setJobState` AFTER a
  // green verdict flipped a verified backup to red.
  it("does not condemn the artifact when a port throws on the way out", async () => {
    const h = makeHarness({
      compareChecksum: () => Promise.reject(new Error("download failed")),
    });
    const outcome = await runVerifyJob(CTX, h.ports);
    expect(outcome.finalState).toBe("UNCHANGED");
    expect(h.artifactStates).toEqual([]);
    expect(h.jobStates).toEqual(["RUNNING", "INCONCLUSIVE"]);
  });

  it("marks the artifact FAILED when fullRestore proves it FAILED", async () => {
    const h = makeHarness({ fullRestore: () => Promise.resolve({ proof: "FAILED", cause: null }) });
    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);
    expect(outcome.finalState).toBe("FAILED");
    expect(h.artifactStates).toEqual(["FAILED"]);
    expect(h.jobStates).toEqual(["RUNNING", "FAILED"]);
  });

  // The job is INCONCLUSIVE, not FAILED: a FAILED job is a process that ran and broke, and this
  // one never got to look. The two were the same row state until the UI had to tell them apart —
  // "could not run" and "the backup is bad" read identically on a jobs list that only had FAILED,
  // and the only way to separate them was to grep the reason string.
  it("leaves the artifact UNCHANGED and marks the job INCONCLUSIVE when fullRestore is INCONCLUSIVE", async () => {
    const h = makeHarness({
      fullRestore: () =>
        Promise.resolve({ proof: "INCONCLUSIVE", cause: "no scratch directory configured" }),
    });
    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);
    // UNCHANGED, not UNOBSERVED: an artifact a previous verify proved good is still VERIFIED, and
    // reporting the sandbox's failure as a downgrade would be a state change nobody made.
    expect(outcome.finalState).toBe("UNCHANGED");
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
    const h = makeHarness({ fullRestore: () => Promise.resolve({ proof: "FAILED", cause: null }) });

    const outcome = await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);

    expect(outcome.finalState).toBe("FAILED");
    expect(h.artifactStates).toEqual(["FAILED"]);
    expect(h.jobReasons.at(-1)).toMatch(/restored but produced no usable schema/);
  });

  // A FAILED proof is issued for two different findings — a restore that completed and counted
  // nothing, and a restore that never completed — and the sentence above was written for both.
  // Observed on a real deployment: a verify FAILED with "restored but produced no usable schema"
  // and no way to tell whether pg_restore had refused the dump or the dump held no tables.
  it("carries the restore's own words when the restore did not complete", async () => {
    const complaint =
      'restore execution failed (exit code 1): pg_restore: error: extension "postgis" is not available';
    const h = makeHarness({
      fullRestore: () => Promise.resolve({ proof: "FAILED", cause: complaint }),
    });

    await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);

    expect(h.jobStates.at(-1)).toBe("FAILED");
    expect(h.jobReasons.at(-1)).toBe(`verify failed: ${complaint}`);
    expect(h.jobReasons.at(-1)).not.toMatch(/produced no usable schema/);
  });

  it("keeps the downgrade beside the restore's words, because they are different claims", async () => {
    const h = makeHarness({
      fullRestore: () => Promise.resolve({ proof: "FAILED", cause: "restore decrypt failed" }),
    });

    await runVerifyJob({ ...CTX, verifyLevel: "FULL_RESTORE" }, h.ports);

    // Not sealed, so no downgrade: the reason is exactly the cause, nothing appended.
    expect(h.jobReasons.at(-1)).toBe("verify failed: restore decrypt failed");
  });

  it("records why a checksum condemned it", async () => {
    const h = makeHarness({ compareChecksum: () => Promise.resolve({ proof: "MISMATCHED" as const, cause: null }) });

    const outcome = await runVerifyJob(CTX, h.ports);

    expect(outcome.finalState).toBe("FAILED");
    expect(h.jobReasons.at(-1)).toMatch(/does not match the checksum in its manifest/);
  });

  it("keeps the downgrade alongside the failure, because they are different claims", async () => {
    // An artifact condemned by a CHECKSUM that only ran because FULL_RESTORE was unavailable is
    // not the same claim as one condemned by a restore. The row has to be able to say which.
    const h = makeHarness({ compareChecksum: () => Promise.resolve({ proof: "MISMATCHED" as const, cause: null }) });

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
