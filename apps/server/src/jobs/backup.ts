// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { resolveExecutionMode, type ExecutionMode } from "./execution-mode.js";

export interface Reservation {
  release(): Promise<void>;
}

export interface ProbeResult {
  serverVersionNum: number;
  scope: { databases: string[]; schemas: string[]; collections: string[] };
  estimatedBytes: number;
}

export interface Capabilities {
  stagedCapable: boolean;
  requiresSeparateGlobalsDump: boolean;
}

export interface Recipients {
  recipients: string[];
  keyIds: string[];
}

export interface UploadResult {
  bucketKey: string;
  manifestKey: string;
  sizeRawBytes: number;
  sizeCompressedBytes: number;
  checksumAlgorithm: string;
  checksum: string;
}

export interface BackupContext {
  jobId: string;
  organizationId: string;
  requestedParallelism: number;
  stagedThresholdBytes: number;
  scratchConfigured: boolean;
}

export interface BackupPorts {
  setState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  probe(): Promise<ProbeResult>;
  capabilities(serverVersionNum: number): Capabilities;
  reserveScratch(estimatedBytes: number): Promise<Reservation>;
  resolveRecipients(): Promise<Recipients>;
  // Builds the descriptor (engines), executes it (runner) and streams
  // dump -> compress -> encrypt -> upload (storage), in that fixed order.
  executeAndUpload(input: {
    mode: ExecutionMode;
    parallelism: number;
    probe: ProbeResult;
    recipients: Recipients;
  }): Promise<UploadResult>;
  // Postgres globals dumped as a separate execution when the capability requires it.
  executeGlobals(input: { recipients: Recipients; probe: ProbeResult }): Promise<void>;
  writeManifest(input: {
    probe: ProbeResult;
    mode: ExecutionMode;
    recipients: Recipients;
    upload: UploadResult;
  }): Promise<void>;
  // Persists the artifact. Its state literal is "UNOBSERVED" — the type makes it impossible to
  // create an artifact as VERIFIED here; only verify may promote it.
  persistArtifact(input: {
    state: "UNOBSERVED";
    probe: ProbeResult;
    mode: ExecutionMode;
    recipients: Recipients;
    upload: UploadResult;
  }): Promise<string>;
}

export interface BackupOutcome {
  ok: boolean;
  artifactId: string | null;
  mode: ExecutionMode | null;
  warnings: string[];
}

// The 11-step pipeline. Scratch is always released in `finally`; the artifact is always born
// UNOBSERVED.
export async function runBackupJob(ctx: BackupContext, ports: BackupPorts): Promise<BackupOutcome> {
  await ports.setState("RUNNING");
  let reservation: Reservation | null = null;
  try {
    const probe = await ports.probe(); // 1
    const caps = ports.capabilities(probe.serverVersionNum); // 2
    const mode = resolveExecutionMode({
      // 3
      requestedParallelism: ctx.requestedParallelism,
      scratchConfigured: ctx.scratchConfigured,
      estimatedBytes: probe.estimatedBytes,
      stagedThresholdBytes: ctx.stagedThresholdBytes,
      stagedCapable: caps.stagedCapable,
    });
    if (mode.mode === "STAGED") {
      reservation = await ports.reserveScratch(probe.estimatedBytes); // 4 (pre-check before dump)
    }
    const recipients = await ports.resolveRecipients();
    const upload = await ports.executeAndUpload({
      // 5, 6, 8
      mode: mode.mode,
      parallelism: mode.parallelism,
      probe,
      recipients,
    });
    if (caps.requiresSeparateGlobalsDump) {
      await ports.executeGlobals({ recipients, probe }); // 7
    }
    await ports.writeManifest({ probe, mode: mode.mode, recipients, upload }); // 9
    const artifactId = await ports.persistArtifact({
      // 10 — UNOBSERVED
      state: "UNOBSERVED",
      probe,
      mode: mode.mode,
      recipients,
      upload,
    });
    await ports.setState("SUCCEEDED");
    return { ok: true, artifactId, mode: mode.mode, warnings: mode.warnings };
  } catch (error) {
    await ports.setState("FAILED", error instanceof Error ? error.message : "unknown error");
    return { ok: false, artifactId: null, mode: null, warnings: [] };
  } finally {
    if (reservation !== null) {
      await reservation.release(); // 11 — always
    }
  }
}
