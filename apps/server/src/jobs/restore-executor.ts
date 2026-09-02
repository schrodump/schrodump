// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The real restore executor: the INVERSE of backup-wiring's upload pipeline. Backup is
// dump -> gzip -> age-encrypt (in-process) -> S3; restore is S3 -> age-decrypt (in-process) ->
// gunzip -> engine restore, into the origin target. Not run in CI (needs Docker + S3 + a target DB);
// its correctness is the dev smoke. The pure helpers here ARE unit-tested (restore-executor.test.ts).
//
// STAGED-FILE pipeline: the decrypted+gunzipped dump is written to a scratch FILE, then that file is
// mounted read-only into the engine restore executor, which reads the FILE (its sourcePath), never a
// stdin. Decryption runs IN-PROCESS via age's Decrypter (the mirror of backup's in-process Encrypter),
// NOT the age binary in a container. Two container-stdin hazards drove this: pg_restore closed its
// stdin the instant it had the whole archive (teardown race), and — subtler — the age executor's
// stdin used a hijacked Docker attach whose demux intermittently leaked attach-protocol framing into
// the container's stdout (~3-13% of runs), corrupting the dump so gunzip failed with "unexpected end
// of file". Reading the dump from a mounted file and decrypting in-process removes the container, the
// runner stdin, and the on-disk identity in one move.
//
// Security: this is the first artifact-decryption path and the first write into a live target. The
// operational age identity stays IN MEMORY (KEK-decrypted upstream) and is handed to the Decrypter;
// it is never written to disk. The decrypted dump file is CLEARTEXT on the scratch volume: it lives
// inside the 0700 reserved dir (which is what keeps it confidential on the host) and is always removed
// in `finally` (success or throw); the file itself is 0644 so the mongo executor, which runs as an
// unprivileged uid, can read it — see the createWriteStream note below. The identity and the decrypted
// target credential never reach a log, the response, or BackupJob.reason.

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { decryptStream } from "../crypto/artifact.js";
import { z } from "zod";
import { resolveCapabilities } from "@schrodump/core/capabilities";
import { SchrodumpError } from "@schrodump/core/errors";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import type { EngineKind } from "@schrodump/core/types";
import { buildExtractStaging } from "@schrodump/engines/staging";
import type { RunMount, Runner } from "@schrodump/runner/runner";
import type { StorageDriver } from "@schrodump/storage/driver";
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
export function artifactBelongsToOrg(
  artifactOrganizationId: string,
  jobOrganizationId: string,
): boolean {
  return artifactOrganizationId === jobOrganizationId;
}

const RestoreScopeSchema = z.object({
  databases: z.array(z.string()).default([]),
  schemas: z.array(z.string()).default([]),
  collections: z.array(z.string()).default([]),
  tables: z.array(z.string()).default([]),
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

// The globals object that sits beside an artifact key, without asking whether the engine writes
// one. globalsKeyFor (below) answers "should this restore read globals?" and needs the engine for
// that; retention asks the different question "what did this backup write?", where the safe answer
// is to name the object and let an absent key be a no-op delete.
export function globalsObjectKey(artifactBucketKey: string): string {
  const idx = artifactBucketKey.lastIndexOf(ARTIFACT_OBJECT);
  if (idx === -1) return artifactBucketKey;
  return artifactBucketKey.slice(0, idx) + GLOBALS_OBJECT;
}

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
  // Whether THIS object is the tar a STAGED backup produced. Per step, not per pipeline: a postgres
  // restore has two of them, and only one is ever a tar. `globals.bin` is plain SQL from
  // `pg_dumpall --globals-only` in every execution mode — untarring it is untarring a text file.
  readonly staged: boolean;
}

// The ordered restore steps. Globals (roles/tablespaces) MUST be restored before the per-database
// artifact for postgres, else the per-db restore fails on a missing role. The descriptor builders
// are deferred (they take the staged dump's mount path) and only invoked for the steps that run.
export function planRestoreSteps(
  bucketKey: string,
  buildRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor,
  globalsKey: string | null,
  buildGlobalsRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor | null,
  staged: boolean,
): RestoreStep[] {
  const steps: RestoreStep[] = [];
  if (globalsKey !== null) {
    steps.push({
      // NEVER staged, whatever the artifact is: pg_dumpall --globals-only emits SQL, and the
      // archive step only ever tars the directory dump.
      staged: false,
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
  steps.push({ key: bucketKey, buildDescriptor: buildRestoreDescriptor, staged });
  return steps;
}

// Node filesystem errno codes that mean the scratch volume, not the artifact, failed the write:
// disk/quota exhaustion (ENOSPC/EDQUOT/EFBIG), an I/O or read-only/permission fault (EIO/EROFS/
// EACCES), or an fd-table limit (EMFILE/ENFILE).
const SCRATCH_WRITE_ERRNOS = new Set([
  "ENOSPC",
  "EDQUOT",
  "EIO",
  "EROFS",
  "EACCES",
  "EMFILE",
  "ENFILE",
  "EFBIG",
]);
// A staging write/open failure (our disk) vs. a decrypt/gunzip failure (the artifact). Detect a Node
// system error either by its errno code OR by the syscall that raised it (write/open/ftruncate), so a
// less common errno on those syscalls is still attributed to our scratch, not the backup.
// A restore interrupted by the process shutdown signal. Deliberately its OWN code: an abort is not
// a claim about the artifact, and verify's classifier maps every code outside RESTORE_FAILED_CODES to
// INCONCLUSIVE — so a `docker stop` leaves the backup UNOBSERVED instead of condemning something
// nothing ever finished looking at.
function abortedRestoreError(correlationId: string): SchrodumpError {
  return new SchrodumpError("restore aborted by shutdown", {
    code: "RESTORE_ABORTED",
    correlationId,
  });
}

function isScratchWriteError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const sys = err as { code?: unknown; syscall?: unknown };
  if (typeof sys.code === "string" && SCRATCH_WRITE_ERRNOS.has(sys.code)) return true;
  return sys.syscall === "write" || sys.syscall === "open" || sys.syscall === "ftruncate";
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
  // A STAGED artifact is a TAR of a directory dump and must be unpacked before the engine restore
  // can read it. STREAM artifacts are a single file and are mounted as-is.
  executionMode?: "STREAM" | "STAGED";
  // Threaded into every run for log correlation and the runner's typed errors.
  correlationId: string;
  // Engine restore descriptor (pg_restore / mysql / mongorestore) built for the mount path the
  // decrypted dump is staged at. Built by the caller which holds the decrypted target connection.
  buildRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor;
  // Postgres globals restore (psql) for the staged path, or null when the engine has no globals.
  buildGlobalsRestoreDescriptor: (sourcePath: string) => ExecutionDescriptor | null;
  // Reserves a 0700 scratch dir that holds the decrypted cleartext dump files; cleanup releases the
  // reservation (recursively removing the dir). The age identity is NOT written here — it decrypts
  // in-process, in memory.
  reserveStaging: () => Promise<{ dir: string; cleanup: () => Promise<void> }>;
  // Extra read-only credential mounts every engine restore executor needs (today only mongo's
  // `--config` password file). Materialized into the reserved staging dir AFTER it exists — so the
  // secret lands on the same swept 0700 volume as the decrypted dump and needs no second scratch
  // reservation (avoiding a self-deadlock on the staged-concurrency semaphore) — and removed before
  // the staging dir is released. Absent for engines that pass the password via env.
  provideExtraMounts?: (
    stagingDir: string,
  ) => Promise<{ mounts: RunMount[]; cleanup: () => Promise<void> }>;
  // The shutdown signal, bound once at createJobExecutor construction and forwarded into every
  // container-creating run so the runner can force-remove the container on abort. Undefined outside
  // a shutdown (or in tests) — the runner behaves exactly as before.
  readonly signal?: AbortSignal;
}

// Downloads each encrypted object, decrypts it in-process (age Decrypter, identity held in memory,
// never on disk) and gunzips it to a scratch FILE, then mounts that file into the engine restore
// executor connected to the origin target. Returns true iff every restore executor exits 0; throws on
// a non-zero exit or a source error so a truncated/failed restore never reports ok. Every decrypted
// dump is always removed in finally; cleanup releases the reserved scratch dir.
export async function runRestorePipeline(deps: RestorePipelineDeps): Promise<boolean> {
  const staging = await deps.reserveStaging();
  // extra is materialized INSIDE the try (not between reserveStaging and the try) so a throw from
  // provideExtraMounts (e.g. ENOSPC/EIO writing mongo's `--config` file) still runs the finally
  // below — releasing the staging reservation instead of leaking its semaphore slot. staging.cleanup()
  // removes the whole reserved dir recursively, so a partial config file left by a half-completed
  // provideExtraMounts is swept by the finally too, not left for age-based gc.
  let extra: { mounts: RunMount[]; cleanup: () => Promise<void> } | null = null;
  try {
    // Materialize any credential mount (mongo's `--config`) into the reserved dir before the
    // executors run; empty for engines that pass the password via env.
    extra = deps.provideExtraMounts ? await deps.provideExtraMounts(staging.dir) : null;
    const steps = planRestoreSteps(
      deps.bucketKey,
      deps.buildRestoreDescriptor,
      deps.globalsKey,
      deps.buildGlobalsRestoreDescriptor,
      deps.executionMode === "STAGED",
    );
    for (const step of steps) {
      // postgres restores globals first, then the database. Starting a second step after the signal
      // trips would decrypt another cleartext dump into scratch inside the grace window, with no
      // time left to remove it.
      if (deps.signal?.aborted === true) throw abortedRestoreError(deps.correlationId);
      await restoreOne(deps, staging.dir, step, extra?.mounts ?? []);
    }
    return true;
  } finally {
    // Remove the credential file before the dir is swept (narrows the cleartext window), then
    // release() recursively removes the reserved dir, sweeping any decrypted dump a per-step cleanup
    // missed after a hard failure. extra stays null when provideExtraMounts itself threw.
    if (extra !== null) await extra.cleanup();
    await staging.cleanup();
  }
}

async function restoreOne(
  deps: RestorePipelineDeps,
  stagingDir: string,
  step: RestoreStep,
  // Credential mounts (mongo `--config`) added to this executor alongside the dump mount; [] for
  // engines that carry the password in env.
  extraMounts: readonly RunMount[],
): Promise<void> {
  // S3 ciphertext -> in-process age decrypt -> gunzip -> a scratch FILE. Then mount that file into
  // the engine restore executor and let it read the FILE (its sourcePath), never a stdin.
  const source = await deps.driver.get(step.key);
  const dumpPath = join(stagingDir, `dump-${randomUUID()}`);

  // A raw S3/driver error can embed the failing URI, and it must never reach BackupJob.reason. Funnel
  // the ciphertext through a PassThrough that rewrites any source error to a generic message before it
  // reaches the decrypt/gunzip pipeline. (age-decrypt and gunzip errors carry no secret; they pass
  // through as-is — e.g. gunzip's "unexpected end of file" on a truncated stream.)
  const ciphertext = new PassThrough();
  source.on("error", () =>
    ciphertext.destroy(
      new SchrodumpError("restore source stream failed", {
        code: "RESTORE_SOURCE_FAILED",
        correlationId: deps.correlationId,
      }),
    ),
  );
  source.pipe(ciphertext);

  try {
    // Decrypt in-process (age Decrypter), then gunzip into the scratch file (0600). No container, no
    // runner stdin: the writable end is a FILE, and the ciphertext never crosses a hijacked Docker
    // attach — the two failure modes the earlier stdin pipelines had.
    try {
      const decrypted = await decryptStream(ciphertext, deps.ageIdentity);
      // 0644, not 0600: the restore executor bind-mounts this file and reads it as a container uid
      // that does not own it. The mongo image runs mongorestore as the unprivileged `mongodb` user
      // (its entrypoint globs `mongo*` and gosu-drops), so an owner-only dump is `permission denied`
      // inside that container (`Failed: open <path>: permission denied`), failing the restore/verify;
      // postgres/mysql run their client as root and would not care. The enclosing 0700 reservation
      // dir is what keeps this cleartext dump confidential on the host — only its owner can traverse
      // to the file — so world-read on the file is inert on the host while letting every engine's
      // throwaway executor read it. (Never reproduces on Docker Desktop, whose VM file-sharing masks
      // the mount's ownership; it is a native-Linux executor failure, caught by CI.)
      // The signal rides the pipeline itself, not just the runner call below. This write IS the
      // cleartext: on a multi-GB artifact it is the longest phase of a restore and the one most
      // likely to be in flight at shutdown. Without cancelling it, the `finally` that removes
      // dumpPath does not run until the write finishes on its own — long past the grace, leaving a
      // decrypted dump on the scratch volume. Destroying the chain routes straight into that
      // `finally` instead.
      await pipeline(
        decrypted,
        createGunzip(),
        createWriteStream(dumpPath, { mode: 0o644 }),
        ...(deps.signal !== undefined ? [{ signal: deps.signal }] : []),
      );
      // createWriteStream's mode is masked by umask; enforce 0644 explicitly (mirrors writeMongoConfig)
      // so the mongo executor can read it regardless of the worker process's umask.
      await chmod(dumpPath, 0o644);
    } catch (err) {
      // A source error rewritten above already carries RESTORE_SOURCE_FAILED and surfaces here
      // THROUGH the decrypt/gunzip pipeline (it rejects when its input stream errors) — pass it
      // through unchanged rather than re-wrapping it as a decrypt failure.
      if (err instanceof SchrodumpError) throw err;
      // Aborting the pipeline above rejects with an AbortError, which is neither a SchrodumpError nor
      // a scratch-write errno — so without this branch it falls through to RESTORE_DECRYPT_FAILED
      // below, a code verify maps to FAILED. That would make a `docker stop` mark an artifact nothing
      // observed as bad: the exact inversion of the thesis. Checked before the scratch-write branch
      // too, so a destroyed write stream's errno cannot win the classification either.
      if (deps.signal?.aborted === true) throw abortedRestoreError(deps.correlationId);
      // A write-side failure on the scratch volume (ENOSPC/EDQUOT/EIO/EROFS/EACCES, an fd limit, ...)
      // rejects the same pipeline, but it means OUR disk failed, not that the artifact is bad. It gets
      // a DISTINCT code because the two are classified oppositely on the verify path: a decrypt/gunzip
      // failure is the artifact's fault → FAILED, whereas a staging write failure is ours →
      // INCONCLUSIVE (leave the backup UNOBSERVED). Condemning a good artifact because our scratch
      // filled up is the exact thesis violation this split prevents.
      if (isScratchWriteError(err)) {
        throw new SchrodumpError("restore staging write failed", {
          code: "RESTORE_WRITE_FAILED",
          correlationId: deps.correlationId,
          cause: err,
        });
      }
      // Everything else here is a genuine age-decrypt or gunzip failure (e.g. zlib's "unexpected end
      // of file" on a truncated stream); its message carries no secret but is kept out of
      // BackupJob.reason regardless, in `cause`, so the reason stays a stable, generic string.
      throw new SchrodumpError("restore decrypt failed", {
        code: "RESTORE_DECRYPT_FAILED",
        correlationId: deps.correlationId,
        cause: err,
      });
    }

    // Flush the staged dump to disk before another process, in another container, reads it. The
    // pipeline resolves once Node closes its own write fd, which leaves the bytes in the page cache;
    // the restore executor reads the file through a separate mount, so it must see the full length,
    // not a short read. fsync forces the data + size metadata out.
    const dumpHandle = await open(dumpPath, "r");
    try {
      await dumpHandle.sync();
    } finally {
      await dumpHandle.close();
    }

    // Mount the decrypted dump read-only; the engine restore reads the file, NOT stdin. Any
    // credential mount (mongo `--config`) rides alongside it — [] for the other engines.
    // A STAGED artifact is a tar: unpack it into a sibling directory and restore from THAT.
    // pg_restore reads a directory-format dump when handed a directory, and myloader takes -d, so
    // the engine descriptors need no change — only the thing mounted at RESTORE_DUMP_PATH does.
    let sourcePath = dumpPath;
    // step.staged, NOT deps.executionMode: the mode describes the ARTIFACT, and a postgres restore
    // stages two different objects. Reading it per pipeline meant a STAGED postgres backup tried to
    // untar its globals SQL, failed with "tar: invalid tar magic", and could therefore never be
    // verified OR restored — while mysql STAGED (no globals step) and postgres STREAM (no extract)
    // both worked, which is why only this combination was broken.
    if (step.staged) {
      const extractedPath = `${dumpPath}-extracted`;
      await mkdir(extractedPath, { recursive: true, mode: 0o700 });
      // Same image as the restore itself: every engine image ships tar, so unpacking introduces no
      // executor image and no digest to pin.
      const restoreImage = step.buildDescriptor(RESTORE_DUMP_PATH).image;
      const extract = await deps.runner.run(
        buildExtractStaging({
          image: restoreImage,
          sourcePath: `${RESTORE_DUMP_PATH}.tar`,
          targetPath: RESTORE_DUMP_PATH,
        }),
        {
          network: deps.network,
          mounts: [
            { source: dumpPath, target: `${RESTORE_DUMP_PATH}.tar`, readOnly: true },
            { source: extractedPath, target: RESTORE_DUMP_PATH, readOnly: false },
          ],
          timeoutMs: deps.timeoutMs,
          correlationId: deps.correlationId,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        },
      );
      if (extract.exitCode !== 0) {
        // The exit code alone says a STAGED artifact cannot be unpacked and nothing about why —
        // and this failure surfaces as an INCONCLUSIVE verify, so the artifact stays UNOBSERVED
        // with no diagnosable cause. RunResult.stderr is already captured, truncated and sanitized
        // by the runner (env values are redacted there); dropping it was pure loss.
        const detail = extract.stderr.trim();
        throw new SchrodumpError(
          detail === ""
            ? `restore extract failed (exit code ${extract.exitCode})`
            : `restore extract failed (exit code ${extract.exitCode}): ${detail}`,
          {
            code: "RESTORE_EXTRACT_FAILED",
            correlationId: deps.correlationId,
          },
        );
      }
      sourcePath = extractedPath;
    }

    const dumpMount: RunMount = { source: sourcePath, target: RESTORE_DUMP_PATH, readOnly: true };
    const restoreResult = await deps.runner.run(step.buildDescriptor(RESTORE_DUMP_PATH), {
      network: deps.network,
      mounts: [dumpMount, ...extraMounts],
      timeoutMs: deps.timeoutMs,
      correlationId: deps.correlationId,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    if (restoreResult.exitCode !== 0) {
      throw new SchrodumpError(`restore execution failed (exit code ${restoreResult.exitCode})`, {
        code: "RESTORE_EXECUTOR_FAILED",
        correlationId: deps.correlationId,
      });
    }
  } finally {
    // Release the S3 read stream. On success it has already ended (fully consumed by the decrypt);
    // on a decrypt/gunzip/exit failure it may still be open, and destroy() frees its socket instead
    // of stranding it until GC. destroy() with no arg emits no 'error'.
    source.destroy();
    // The decrypted dump is cleartext on the scratch volume — always remove it (success and throw).
    // For a STAGED artifact the UNPACKED directory beside it is cleartext too, and larger.
    await rm(dumpPath, { force: true });
    await rm(`${dumpPath}-extracted`, { recursive: true, force: true });
  }
}
