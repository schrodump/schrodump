// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export type VerifyLevel = "NONE" | "CHECKSUM" | "FULL_RESTORE";

export interface VerifyContext {
  jobId: string;
  artifactId: string;
  verifyLevel: VerifyLevel;
  // Sealed destination: the server holds no identity, so FULL_RESTORE is impossible.
  sealed: boolean;
}

export interface VerifyPorts {
  setJobState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  // The ONLY place an artifact reaches VERIFIED. The literal type forbids any other final state.
  setArtifactState(state: "VERIFIED" | "FAILED"): Promise<void>;
  // Downloads the stored object, recomputes its checksum, compares against the manifest.
  checksumMatches(): Promise<boolean>;
  // Ephemeral container of the correct major, restore, assertions, then destroy — isolated network.
  fullRestore(): Promise<boolean>;
}

export interface VerifyOutcome {
  // UNOBSERVED only when verify is off (NONE); otherwise VERIFIED or FAILED.
  finalState: "VERIFIED" | "FAILED" | "UNOBSERVED";
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

  try {
    const ok = level === "FULL_RESTORE" ? await ports.fullRestore() : await ports.checksumMatches();
    await ports.setArtifactState(ok ? "VERIFIED" : "FAILED");
    await ports.setJobState(ok ? "SUCCEEDED" : "FAILED", degradedReason ?? undefined);
    return {
      finalState: ok ? "VERIFIED" : "FAILED",
      effectiveLevel: level,
      degraded: degradedReason !== null,
    };
  } catch (error) {
    // A verify failure marks the artifact FAILED — it is NEVER deleted here.
    await ports.setArtifactState("FAILED");
    await ports.setJobState("FAILED", error instanceof Error ? error.message : "verify error");
    return { finalState: "FAILED", effectiveLevel: level, degraded: degradedReason !== null };
  }
}
