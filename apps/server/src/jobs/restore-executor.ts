// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The real restore executor: the INVERSE of backup-wiring's upload pipeline. Backup is
// dump -> gzip -> age-encrypt -> S3; restore is S3 -> age-decrypt -> gunzip -> engine restore,
// into the origin target. Not run in CI (needs Docker + S3 + a target DB); its correctness is the
// dev smoke. The pure helpers here ARE unit-tested (restore-executor.test.ts).
//
// STAGED-FILE pipeline: the decrypted+gunzipped dump is written to a scratch FILE, then that file
// is mounted read-only into the engine restore executor, which reads the FILE (its sourcePath), not
// a second stdin. Feeding the S3 ciphertext into age on stdin stays reliable — age reads its stdin
// to EOF and never closes early. The flaky part was the SECOND stdin into pg_restore: it closed its
// stdin the instant it had the whole custom-format archive, racing the stream teardown (spurious
// gunzip Z_BUF_ERROR, an age backpressure deadlock, truncated-input exit 1). Staging removes it.
//
// Security: this is the first artifact-decryption path and the first write into a live target. The
// operational age identity is written to a 0600 scratch file, mounted READ-ONLY into the age
// executor (never on argv), and deleted in `finally`. The decrypted dump file is CLEARTEXT on the
// scratch volume: 0600, inside the 0700 reserved dir, and always removed in `finally` (success or
// throw). The identity and the decrypted target credential never reach a log, the response, or
// BackupJob.reason.

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
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

const RestoreScopeSchema = z.object({
  databases: z.array(z.string()).default([]),
  schemas: z.array(z.string()).default([]),
  collections: z.array(z.string()).default([]),
});

export type RestoreScope = z.infer<typeof RestoreScopeSchema>;

// A malformed origin-target scope must fail LOUD, never silently degrade to an empty scope: an
// empty-scope restore born from a parse failure is worse than a clear error (mirrors the fail-loud
// stance of restoreParamsOf). An absent/empty field defaults to [] — a legitimately unscoped
// target is valid; a non-array value is not.
export function restoreScopeOf(raw: unknown): RestoreScope {
  return RestoreScopeSchema.parse(raw);
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
  // Builds the engine restore descriptor for this step given the path the decrypted dump is mounted
  // at inside the executor. Deferred because that path only exists once the step has staged the dump.
  readonly buildDescriptor: (sourcePath: string) => ExecutionDescriptor;
}

// The ordered restore steps. Globals (roles/tablespaces) MUST be restored before the per-database
// artifact for postgres, else the per-db restore fails on a missing role. The descriptor builders
// are deferred (they take the staged dump's mount path) and only invoked for the steps that run.
export function planRestoreSteps(
  bucketKey: string,
  buildRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor,
  globalsKey: string | null,
  buildGlobalsRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor | null,
): RestoreStep[] {
  const steps: RestoreStep[] = [];
  if (globalsKey !== null) {
    steps.push({
      key: globalsKey,
      buildDescriptor: (sourcePath): ExecutionDescriptor => {
        const descriptor = buildGlobalsRestoreDescriptor(sourcePath);
        // Structural guard: globalsKey is non-null only for engines that also implement
        // buildGlobalsRestore (both derive from requiresSeparateGlobalsDump), so this is never hit.
        if (descriptor === null) {
          throw new Error("globals restore descriptor unavailable despite a globals object");
        }
        return descriptor;
      },
    });
  }
  steps.push({ key: bucketKey, buildDescriptor: buildRestoreDescriptor });
  return steps;
}

// ---------------------------------------------------------------------------
// The staged-file pipeline (Docker/S3/target — smoke-verified, not unit-tested)
// ---------------------------------------------------------------------------

// Where the decrypted dump file is mounted read-only inside the engine restore executor. The engine
// descriptor reads the dump from THIS path (its sourcePath), never a second stdin.
const RESTORE_DUMP_PATH = "/var/lib/schrodump/restore-source";

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
  // Engine restore descriptor (pg_restore / mysql / mongorestore) built for the mount path the
  // decrypted dump is staged at. Built by the caller which holds the decrypted target connection.
  buildRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor;
  // Postgres globals restore (psql) for the staged path, or null when the engine has no globals.
  buildGlobalsRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor | null;
  // Reserves a 0700 scratch dir that holds BOTH the 0600 identity and the decrypted cleartext dump
  // files; cleanup releases the reservation (recursively removing the dir).
  reserveStaging: () => Promise<{ dir: string; cleanup: () => Promise<void> }>;
}

// Downloads each encrypted object, decrypts (age, identity mounted, never on argv) and gunzips it to
// a scratch FILE, then mounts that file into the engine restore executor connected to the origin
// target. Returns true iff every restore executor exits 0; throws on a non-zero exit or a source
// error so a truncated/failed restore never reports ok. The identity file and every decrypted dump
// are always removed in finally; cleanup releases the reserved scratch dir.
export async function runRestorePipeline(deps: RestorePipelineDeps): Promise<boolean> {
  const staging = await deps.reserveStaging();
  const identityPath = join(staging.dir, `restore-identity-${randomUUID()}`);
  try {
    // 0600, mode set explicitly (writeFile's mode is subject to umask), mirroring ScratchManager.
    await writeFile(identityPath, deps.ageIdentity, { mode: 0o600 });
    await chmod(identityPath, 0o600);

    const steps = planRestoreSteps(
      deps.bucketKey,
      deps.buildRestoreDescriptor,
      deps.globalsKey,
      deps.buildGlobalsRestoreDescriptor,
    );
    for (const step of steps) {
      await restoreOne(deps, identityPath, staging.dir, step);
    }
    return true;
  } finally {
    // Remove the identity first, then release the reservation. release() recursively removes the
    // dir, sweeping any decrypted dump a per-step cleanup missed after a hard failure.
    await rm(identityPath, { force: true });
    await staging.cleanup();
  }
}

async function restoreOne(
  deps: RestorePipelineDeps,
  identityPath: string,
  stagingDir: string,
  step: RestoreStep,
): Promise<void> {
  // S3 ciphertext -> age --decrypt (identity mounted ro) -> gunzip -> a scratch FILE. Then mount
  // that file into the engine restore executor and let it read the FILE (no second stdin).
  const source = await deps.driver.get(step.key);
  const decrypted = new PassThrough();
  const dumpPath = join(stagingDir, `dump-${randomUUID()}`);

  // Fail fast on a source-read (S3) error. `source` is piped into the age executor's stdin by the
  // runner, OUTSIDE the pipeline chain below, so its errors are not caught by that pipeline. Without
  // this guard an S3 error mid-stream never closes age's stdin (no EOF), age hangs, and the failure
  // only surfaces as RUNNER_TIMEOUT. The message is generic — a raw driver error can embed the
  // failing URI, and it must never reach BackupJob.reason.
  const sourceError = new Promise<never>((_resolve, reject) => {
    source.on("error", () => reject(new Error("restore source stream failed")));
  });
  sourceError.catch(() => undefined); // no unhandledRejection when the run wins the race

  const identityMount: RunMount = { source: identityPath, target: AGE_IDENTITY_PATH, readOnly: true };
  const ageRun = deps.runner.run(buildAgeDecryptDescriptor(), {
    network: deps.network,
    mounts: [identityMount],
    stdin: source,
    stdout: decrypted,
    timeoutMs: deps.timeoutMs,
    correlationId: deps.correlationId,
  });
  ageRun.catch(() => undefined); // if the sourceError path wins, don't leak a late rejection

  try {
    // Read age's output to EOF, gunzip, into the scratch file (0600). No teardown race: the writable
    // end is a FILE, which never closes early the way pg_restore's stdin did. age reads the S3
    // ciphertext fully and never closes early, so racing the source error only guards an S3 failure.
    await Promise.race([
      pipeline(decrypted, createGunzip(), createWriteStream(dumpPath, { mode: 0o600 })),
      sourceError,
    ]);

    // Success is StatusCode 0, never inferred from EOF: a process that ran without complaint proves
    // nothing. Check the age exit code only after its output is fully staged.
    const ageResult = await ageRun;
    if (ageResult.exitCode !== 0) {
      throw new Error(`age decrypt failed (exit code ${ageResult.exitCode})`);
    }

    // Mount the decrypted dump read-only; the engine restore reads the file, NOT stdin.
    const dumpMount: RunMount = { source: dumpPath, target: RESTORE_DUMP_PATH, readOnly: true };
    const restoreResult = await deps.runner.run(step.buildDescriptor(RESTORE_DUMP_PATH), {
      network: deps.network,
      mounts: [dumpMount],
      timeoutMs: deps.timeoutMs,
      correlationId: deps.correlationId,
    });
    if (restoreResult.exitCode !== 0) {
      throw new Error(`restore execution failed (exit code ${restoreResult.exitCode})`);
    }
  } finally {
    // The decrypted dump is cleartext on the scratch volume — always remove it (success and throw).
    await rm(dumpPath, { force: true });
  }
}
