// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export type VerifyLevel = "NONE" | "CHECKSUM" | "FULL_RESTORE";

// What a FULL_RESTORE attempt proved. INCONCLUSIVE means our own infra (sandbox, runner,
// network) failed to even attempt the restore — it says nothing about the artifact, so it must
// never FAIL it. Only VERIFIED/FAILED are genuine claims about the artifact's content.
export type VerifyProof = "VERIFIED" | "FAILED" | "INCONCLUSIVE";

// The proof plus the words the attempt itself produced. A FAILED proof covers two different
// findings: a restore that completed and then counted nothing, and a restore that never completed
// (pg_restore refusing an extension the sandbox image lacks, a mysql client aborting on a DEFINER
// the sandbox has no user for). Both condemn the artifact — the operator's next step is not the
// same, and until `cause` existed the job reason was one fixed sentence for both, "the artifact
// restored but produced no usable schema", written also when nothing had restored.
// What a CHECKSUM attempt proved, in the same three-way shape as FullRestoreResult and for the
// same reason. `checksumMatches` used to return a boolean and stream the object inside the try,
// so ANY failure of the download — a 503 from the bucket, a reset socket, a timeout, an expired
// credential — fell into the catch below and marked the artifact FAILED. That is the product's
// central claim made backwards: it condemned a backup because we could not look at it, fired an
// ARTIFACT_FAILED notification, and invited the operator to delete the copy that was fine.
//
// MISMATCHED and a missing object are verdicts: the bytes are not what the manifest recorded, or
// there are no bytes. Everything else is INCONCLUSIVE, which is what "the check could not run"
// has meant on the FULL_RESTORE path since it got its own job state.
export type ChecksumProof = "MATCHED" | "MISMATCHED" | "INCONCLUSIVE";

export interface ChecksumResult {
  proof: ChecksumProof;
  // Redacted words from the attempt, safe to persist as the job reason. Null when there is
  // nothing to add beyond the proof.
  cause: string | null;
}

export interface FullRestoreResult {
  proof: VerifyProof;
  // Built from the runner's redacted stderr (never driver prose), so it is safe to persist as the
  // job reason. Null when there is nothing to add; runVerifyJob then keeps the generic sentence.
  cause: string | null;
}

export interface VerifyContext {
  jobId: string;
  artifactId: string;
  verifyLevel: VerifyLevel;
  // Sealed destination: the server holds no identity, so FULL_RESTORE is impossible.
  sealed: boolean;
}

export interface VerifyPorts {
  // INCONCLUSIVE is a job state of its own, not a FAILED with a particular reason: FAILED is a
  // process that ran and broke, INCONCLUSIVE never got to look. The jobs list has to tell "the
  // backup is bad" from "the check could not run", and grepping the reason string was the only
  // handle it had while both were FAILED.
  setJobState(
    state: "RUNNING" | "SUCCEEDED" | "FAILED" | "INCONCLUSIVE",
    reason?: string,
  ): Promise<void>;
  // The ONLY place an artifact reaches VERIFIED. The literal type forbids any other final state.
  setArtifactState(state: "VERIFIED" | "FAILED"): Promise<void>;
  // Downloads the stored object, recomputes its checksum, compares against the manifest.
  // Three-way, like fullRestore: MATCHED/MISMATCHED are claims about the artifact, INCONCLUSIVE
  // means we never got to compare.
  compareChecksum(): Promise<ChecksumResult>;
  // Ephemeral container of the correct major, restore, assertions, then destroy — isolated network.
  fullRestore(): Promise<FullRestoreResult>;
}

export interface VerifyOutcome {
  // UNOBSERVED when verify is off (NONE): nothing looked, and nothing ever will for this artifact.
  // UNCHANGED when the check could not run: the artifact keeps whatever state it already had, which
  // is UNOBSERVED for one nothing had looked at and VERIFIED for one a previous verify had proven.
  // Calling the second case UNOBSERVED would report a downgrade that did not happen.
  finalState: "VERIFIED" | "FAILED" | "UNOBSERVED" | "UNCHANGED";
  effectiveLevel: VerifyLevel;
  degraded: boolean;
}

// The verify result is the sole authority over the artifact's final state. An artifact that never
// runs verify stays UNOBSERVED — this is the central behavior of the product, not a detail.
export async function runVerifyJob(ctx: VerifyContext, ports: VerifyPorts): Promise<VerifyOutcome> {
  await ports.setJobState("RUNNING");

  let level = ctx.verifyLevel;
  let degradedReason: string | null = null;
  if (level === "FULL_RESTORE" && ctx.sealed) {
    level = "CHECKSUM";
    degradedReason = "sealed destination: FULL_RESTORE downgraded to CHECKSUM";
  }

  // Verify off: nothing promotes the artifact; it remains UNOBSERVED.
  if (level === "NONE") {
    await ports.setJobState("SUCCEEDED", "verify level NONE — artifact remains UNOBSERVED");
    return { finalState: "UNOBSERVED", effectiveLevel: "NONE", degraded: false };
  }

  // Condemning an artifact is the most consequential verdict this product issues, and it was
  // issued in silence: the reason below used to be `degradedReason ?? undefined`, which is
  // undefined whenever nothing was downgraded. A FAILED artifact therefore carried a FAILED job
  // with a null reason, a null exit code and no stderr — the operator saw a colour and nothing
  // else. Observed on a real deployment where the artifact genuinely WAS bad; the verdict was
  // right and there was no way to learn how it had been reached.
  //
  // A downgrade is still recorded when both apply: an artifact condemned by a CHECKSUM that ran
  // only because FULL_RESTORE was unavailable is a different claim from one condemned by a
  // restore, and the row has to be able to say which.
  const verdict = (ok: boolean, failure: string): string | undefined =>
    ok
      ? (degradedReason ?? undefined)
      : [failure, degradedReason].filter((part) => part !== null).join("; ");

  try {
    if (level === "FULL_RESTORE") {
      const { proof, cause } = await ports.fullRestore();
      if (proof === "INCONCLUSIVE") {
        // Our own infra failed to run the restore — say nothing about the artifact. It stays
        // UNOBSERVED, exactly as if verify had never run. The job says the same: INCONCLUSIVE, not
        // FAILED, because nothing broke that the artifact is to blame for.
        await ports.setJobState(
          "INCONCLUSIVE",
          "verify inconclusive: the sandbox could not run — artifact unchanged",
        );
        return {
          finalState: "UNCHANGED",
          effectiveLevel: level,
          degraded: degradedReason !== null,
        };
      }
      const ok = proof === "VERIFIED";
      await ports.setArtifactState(ok ? "VERIFIED" : "FAILED");
      await ports.setJobState(
        ok ? "SUCCEEDED" : "FAILED",
        verdict(
          ok,
          `verify failed: ${cause ?? "the artifact restored but produced no usable schema"}`,
        ),
      );
      return {
        finalState: ok ? "VERIFIED" : "FAILED",
        effectiveLevel: level,
        degraded: degradedReason !== null,
      };
    }

    const { proof, cause } = await ports.compareChecksum();
    if (proof === "INCONCLUSIVE") {
      // We could not read the object. That says nothing about the object, so the artifact is left
      // exactly as it was — UNOBSERVED if nothing had looked, VERIFIED if something already had.
      await ports.setJobState(
        "INCONCLUSIVE",
        `verify inconclusive: ${cause ?? "the stored object could not be read"} — artifact unchanged`,
      );
      return { finalState: "UNCHANGED", effectiveLevel: level, degraded: degradedReason !== null };
    }
    const ok = proof === "MATCHED";
    await ports.setArtifactState(ok ? "VERIFIED" : "FAILED");
    await ports.setJobState(
      ok ? "SUCCEEDED" : "FAILED",
      verdict(
        ok,
        `verify failed: ${cause ?? "the stored object does not match the checksum in its manifest"}`,
      ),
    );
    return {
      finalState: ok ? "VERIFIED" : "FAILED",
      effectiveLevel: level,
      degraded: degradedReason !== null,
    };
  } catch (error) {
    // Reaching here means OUR machinery threw — a port rejected, a state write lost its connection
    // — after every verdict path above has already set the artifact explicitly. It used to mark the
    // artifact FAILED, which meant a database blip in `setJobState` AFTER a green verdict flipped a
    // verified backup to red. An artifact is condemned by a verdict about the artifact, never by an
    // exception on the way out.
    await ports.setJobState(
      "INCONCLUSIVE",
      `verify inconclusive: ${error instanceof Error ? error.message : "verify error"} — artifact unchanged`,
    );
    return { finalState: "UNCHANGED", effectiveLevel: level, degraded: degradedReason !== null };
  }
}
