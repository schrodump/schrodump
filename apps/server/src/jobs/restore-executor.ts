// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The real restore executor: the INVERSE of backup-wiring's upload pipeline. Backup is
// dump -> gzip -> age-encrypt -> S3; restore is S3 -> age-decrypt -> gunzip -> engine restore,
// into the origin target. Not run in CI (needs Docker + S3 + a target DB); its correctness is the
// dev smoke. The pure helpers here ARE unit-tested (restore-executor.test.ts).
//
// Security: this is the first artifact-decryption path and the first write into a live target. The
// operational age identity is written to a 0600 scratch file, mounted READ-ONLY into the age
// executor (never on argv), and deleted in `finally`. The identity and the decrypted target
// credential never reach a log, the response, or BackupJob.reason.

import { randomUUID } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { resolveCapabilities } from "@schrodump/core/capabilities";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import type { EngineKind } from "@schrodump/core/types";
import type { RunMount, Runner } from "@schrodump/runner/runner";
import type { StorageDriver } from "@schrodump/storage/driver";
import { AGE_IDENTITY_PATH, buildAgeDecryptDescriptor } from "../crypto/artifact.js";
import type { RestoreTarget } from "./restore.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const RestoreParamsSchema = z.object({
  target: z.enum(["FULL_CLUSTER", "DATABASE", "SCHEMA", "TABLE", "COLLECTION"]),
  confirmExistingDatabase: z.boolean(),
  triggeredByUserId: z.string().min(1),
});

export interface RestoreParams {
  target: RestoreTarget;
  confirmExistingDatabase: boolean;
  triggeredByUserId: string;
}

// A RESTORE job MUST carry its params (the route persisted them); a null/garbage value is a hard
// error, never a silent default that would restore with the wrong scope.
export function restoreParamsOf(raw: unknown): RestoreParams {
  return RestoreParamsSchema.parse(raw);
}

// SECURITY: a RESTORE job may only ever touch an artifact in its OWN organization. The worker runs
// on raw prisma (system process), so this ownership check is explicit and happens BEFORE any
// decrypt — a job referencing another org's artifact must fail, never proceed.
export function artifactBelongsToOrg(artifactOrganizationId: string, jobOrganizationId: string): boolean {
  return artifactOrganizationId === jobOrganizationId;
}

const ARTIFACT_OBJECT = "artifact.bin";
const GLOBALS_OBJECT = "globals.bin";

// Postgres is the only engine that uploads a separate globals.bin (pg_dumpall --globals-only),
// stored as a sibling of artifact.bin under the same job prefix (see backup-wiring objectKey()).
// For every other engine there is no globals object. Derived from the capability matrix, not a
// hardcoded engine check, so the single source of truth stays in @schrodump/core.
export function globalsKeyFor(
  engine: EngineKind,
  serverVersionNum: number,
  bucketKey: string,
): string | null {
  if (!resolveCapabilities(engine, serverVersionNum).requiresSeparateGlobalsDump) return null;
  const idx = bucketKey.lastIndexOf(ARTIFACT_OBJECT);
  if (idx === -1) return null;
  return bucketKey.slice(0, idx) + GLOBALS_OBJECT;
}

export interface RestoreStep {
  readonly key: string;
  readonly descriptor: ExecutionDescriptor;
}

// The ordered restore steps. Globals (roles/tablespaces) MUST be restored before the per-database
// artifact for postgres, else the per-db restore fails on a missing role. The descriptor builders
// are only invoked for the steps that run.
export function planRestoreSteps(
  bucketKey: string,
  buildRestoreDescriptor: () => ExecutionDescriptor,
  globalsKey: string | null,
  buildGlobalsRestoreDescriptor: () => ExecutionDescriptor | null,
): RestoreStep[] {
  const steps: RestoreStep[] = [];
  if (globalsKey !== null) {
    const globalsDescriptor = buildGlobalsRestoreDescriptor();
    if (globalsDescriptor !== null) steps.push({ key: globalsKey, descriptor: globalsDescriptor });
  }
  steps.push({ key: bucketKey, descriptor: buildRestoreDescriptor() });
  return steps;
}

// ---------------------------------------------------------------------------
// Identity file (0600, deleted in finally)
// ---------------------------------------------------------------------------

export interface IdentityFile {
  readonly path: string;
  cleanup(): Promise<void>;
}

// Writes the KEK-decrypted operational identity to a 0600 file the age executor mounts read-only.
// The mode is set explicitly (writeFile's mode is subject to umask), mirroring ScratchManager's
// 0700 enforcement. cleanup is idempotent so it is always safe to call in a finally block.
export async function createIdentityFile(
  dir: string,
  jobId: string,
  identity: string,
): Promise<IdentityFile> {
  const path = join(dir, `restore-identity-${jobId}-${randomUUID()}`);
  await writeFile(path, identity, { mode: 0o600 });
  await chmod(path, 0o600);
  let removed = false;
  return {
    path,
    cleanup: async (): Promise<void> => {
      if (removed) return;
      removed = true;
      await rm(path, { force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// The streaming pipeline (Docker/S3/target — smoke-verified, not unit-tested)
// ---------------------------------------------------------------------------

export interface RestorePipelineDeps {
  driver: StorageDriver;
  runner: Runner;
  // The artifact.bin key.
  bucketKey: string;
  // The globals.bin key for postgres, else null.
  globalsKey: string | null;
  // AGE-SECRET-KEY-1... — the KEK-decrypted operational identity.
  ageIdentity: string;
  // Isolated executor network; never inherited.
  network: string;
  timeoutMs: number;
  // Threaded into every run for log correlation and the runner's typed errors.
  correlationId: string;
  // Engine restore descriptor (pg_restore / mysql / mongorestore), built by the caller which holds
  // the decrypted target connection.
  buildRestoreDescriptor: () => ExecutionDescriptor;
  // Postgres globals restore (psql), or null when the engine has no separate globals.
  buildGlobalsRestoreDescriptor: () => ExecutionDescriptor | null;
  // Materializes the identity to a 0600 file mounted read-only into the age executor.
  writeIdentityFile: (identity: string) => Promise<IdentityFile>;
}

// Downloads the encrypted object, pipes it through the age-decrypt executor (identity mounted,
// never on argv) then gunzip, into the engine restore executor connected to the origin target.
// Returns true iff every executor exits 0; throws on a non-zero exit or a source-stream error so
// a truncated/failed restore never reports ok. The identity file is always removed in finally.
export async function runRestorePipeline(deps: RestorePipelineDeps): Promise<boolean> {
  const identityFile = await deps.writeIdentityFile(deps.ageIdentity);
  try {
    const steps = planRestoreSteps(
      deps.bucketKey,
      deps.buildRestoreDescriptor,
      deps.globalsKey,
      deps.buildGlobalsRestoreDescriptor,
    );
    for (const step of steps) {
      await restoreOne(deps, identityFile.path, step);
    }
    return true;
  } finally {
    await identityFile.cleanup();
  }
}

async function restoreOne(
  deps: RestorePipelineDeps,
  identityPath: string,
  step: RestoreStep,
): Promise<void> {
  // S3 ciphertext -> age --decrypt (identity mounted ro) -> gzip'd dump -> gunzip -> engine restore.
  const source = await deps.driver.get(step.key);
  const decrypted = new PassThrough();
  const gunzipped = createGunzip();

  // Fail fast on a source/intermediate stream error. Without this, an S3 or decrypt error mid-stream
  // is swallowed by the runner's stdin pipe (the container never sees EOF) and only surfaces as
  // RUNNER_TIMEOUT (RT3a). Surface it promptly instead. The message is generic — a raw driver error
  // can embed the failing URI, and it must never reach BackupJob.reason.
  const streamError = new Promise<never>((_resolve, reject) => {
    const onError = (): void => reject(new Error("restore source stream failed"));
    source.on("error", onError);
    decrypted.on("error", onError);
    gunzipped.on("error", onError);
  });
  streamError.catch(() => undefined); // no unhandledRejection when the runs win the race

  const identityMount: RunMount = { source: identityPath, target: AGE_IDENTITY_PATH, readOnly: true };

  const decryptRun = deps.runner.run(buildAgeDecryptDescriptor(), {
    network: deps.network,
    mounts: [identityMount],
    stdin: source,
    stdout: decrypted,
    timeoutMs: deps.timeoutMs,
    correlationId: deps.correlationId,
  });

  decrypted.pipe(gunzipped);

  const restoreRun = deps.runner.run(step.descriptor, {
    network: deps.network,
    mounts: [],
    stdin: gunzipped,
    timeoutMs: deps.timeoutMs,
    correlationId: deps.correlationId,
  });

  const runs = Promise.all([decryptRun, restoreRun]);
  runs.catch(() => undefined); // if the streamError path wins, don't leak a late rejection
  const [decryptResult, restoreResult] = await Promise.race([runs, streamError]);

  // A process that ran without complaint proves nothing: success is StatusCode 0, never inferred
  // from EOF. Throw BEFORE returning so runRestoreJob marks the job FAILED — the alternative is a
  // half-restored target reported ok.
  if (decryptResult.exitCode !== 0) {
    throw new Error(`age decrypt failed (exit code ${decryptResult.exitCode})`);
  }
  if (restoreResult.exitCode !== 0) {
    throw new Error(`restore execution failed (exit code ${restoreResult.exitCode})`);
  }
}
