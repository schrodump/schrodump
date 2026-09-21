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
  // The engine's ceiling on parallel dump workers. Read here so a policy cannot ask for more
  // connections against a customer's database than the engine is declared to support.
  maxParallelism: number;
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
  // Absent means size never selects STAGED — see resolveExecutionMode's note.
  stagedThresholdBytes?: number;
  scratchConfigured: boolean;
  // Required, and passed straight through — see resolveExecutionMode's note on it.
  singleDatabaseStagingScope: readonly string[] | null;
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
  // Deletes every object this backup has written to the bucket so far — artifact.bin, globals.bin,
  // manifest.json, whichever exist. Called when the job fails before its Artifact row does: without
  // a row nothing ever learns those keys (retention and the delete route both start from the row),
  // so they would stay in the bucket for good — a postgres globals dump with role password hashes
  // among them. Rejects when the delete fails, so the job's reason can say the objects remain.
  discardObjects(): Promise<void>;
}

export interface BackupOutcome {
  ok: boolean;
  artifactId: string | null;
  mode: ExecutionMode | null;
  warnings: string[];
}

// A failed job's reason, plus a note when the objects it had already written could not be removed.
// Deliberately never thrown: the dump's own failure is the root cause and must stay the reason's
// subject — but an orphan nobody can see is exactly what the note exists to prevent, so the note
// is not swallowed either.
async function discardingObjects(ports: BackupPorts, reason: string): Promise<string> {
  try {
    await ports.discardObjects();
    return reason;
  } catch {
    return `${reason} (and the objects it had already written to the bucket could not be removed)`;
  }
}

// The 11-step pipeline. Scratch is always released in `finally`; the artifact is always born
// UNOBSERVED.
export async function runBackupJob(ctx: BackupContext, ports: BackupPorts): Promise<BackupOutcome> {
  await ports.setState("RUNNING");
  let reservation: Reservation | null = null;
  // Once the row exists the objects are the artifact's, and deleting them would leave a row
  // pointing at nothing. Before it, they belong to nobody: a globals dump refused by the server, a
  // manifest write or a row insert that failed all used to leave artifact.bin (and whatever followed
  // it) in the bucket with no row — which is how a 154 KB artifact.bin outlived a FAILED postgres
  // backup.
  let persisted = false;
  try {
    const probe = await ports.probe(); // 1
    const caps = ports.capabilities(probe.serverVersionNum); // 2
    const mode = resolveExecutionMode({
      // 3
      requestedParallelism: ctx.requestedParallelism,
      scratchConfigured: ctx.scratchConfigured,
      estimatedBytes: probe.estimatedBytes,
      ...(ctx.stagedThresholdBytes !== undefined
        ? { stagedThresholdBytes: ctx.stagedThresholdBytes }
        : {}),
      stagedCapable: caps.stagedCapable,
      maxParallelism: caps.maxParallelism,
      singleDatabaseStagingScope: ctx.singleDatabaseStagingScope,
    });
    // Unreachable while STAGED is disabled (resolveExecutionMode explains why). Kept, not deleted:
    // the directory pipeline that re-enables STAGED needs exactly this reserve/release lifecycle.
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
    persisted = true;
    // A degradation is written on the job it happened to. The warnings were returned in the outcome
    // and read by nobody, so a policy asking for parallelism 4 over an unscoped mysql target would
    // stream at 1 with no trace of why. The ledger already shows a SUCCEEDED job's reason as what
    // the run reported.
    await ports.setState(
      "SUCCEEDED",
      mode.warnings.length > 0 ? mode.warnings.join("; ") : undefined,
    );
    return { ok: true, artifactId, mode: mode.mode, warnings: mode.warnings };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    await ports.setState("FAILED", persisted ? reason : await discardingObjects(ports, reason));
    return { ok: false, artifactId: null, mode: null, warnings: [] };
  } finally {
    if (reservation !== null) {
      await reservation.release(); // 11 — always
    }
  }
}
