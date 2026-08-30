// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import type { RunMount, RunOptions, RunResult, Runner } from "@schrodump/runner/runner";
import type { StorageDriver } from "@schrodump/storage/driver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactBelongsToOrg,
  globalsKeyFor,
  planRestoreSteps,
  restoreParamsOf,
  restoreScopeOf,
  runRestorePipeline,
} from "./restore-executor.js";

describe("restoreParamsOf", () => {
  it("reads a valid RESTORE job's params", () => {
    const p = restoreParamsOf({ target: "DATABASE", confirmExistingDatabase: true, triggeredByUserId: "u1" });
    expect(p).toEqual({ target: "DATABASE", confirmExistingDatabase: true, triggeredByUserId: "u1" });
  });

  it("throws on missing/garbage params (a RESTORE job must carry them)", () => {
    expect(() => restoreParamsOf(null)).toThrow();
    expect(() => restoreParamsOf({ target: "NOPE" })).toThrow();
    // A blank user id is not a valid trigger — never audit a restore to nobody.
    expect(() => restoreParamsOf({ target: "DATABASE", confirmExistingDatabase: false, triggeredByUserId: "" })).toThrow();
  });
});

describe("artifactBelongsToOrg", () => {
  it("is true only when the artifact's org matches the job's org", () => {
    expect(artifactBelongsToOrg("org-a", "org-a")).toBe(true);
    expect(artifactBelongsToOrg("org-a", "org-b")).toBe(false);
  });
});

describe("restoreScopeOf", () => {
  it("parses a full scope and defaults missing arrays to empty", () => {
    expect(restoreScopeOf({ databases: ["app"], schemas: ["public"], collections: [] })).toEqual({
      databases: ["app"],
      schemas: ["public"],
      collections: [],
    });
    // A legitimately unscoped target (full instance) is valid, not a failure.
    expect(restoreScopeOf({})).toEqual({ databases: [], schemas: [], collections: [] });
  });

  it("fails LOUD on a malformed scope instead of degrading to empty", () => {
    expect(() => restoreScopeOf(null)).toThrow();
    expect(() => restoreScopeOf({ databases: "app" })).toThrow();
    expect(() => restoreScopeOf({ databases: [1, 2] })).toThrow();
  });
});

describe("globalsKeyFor", () => {
  it("derives the sibling globals.bin key for postgres", () => {
    expect(globalsKeyFor("postgres", 160002, "backups/org1/job1/artifact.bin")).toBe(
      "backups/org1/job1/globals.bin",
    );
  });

  it("is null for engines that do not need a separate globals dump", () => {
    expect(globalsKeyFor("mysql", 80036, "backups/org1/job1/artifact.bin")).toBeNull();
    expect(globalsKeyFor("mariadb", 110402, "backups/org1/job1/artifact.bin")).toBeNull();
    expect(globalsKeyFor("mongodb", 80004, "backups/org1/job1/artifact.bin")).toBeNull();
  });
});

describe("planRestoreSteps", () => {
  // A restore descriptor built for a given mount path; the command carries a label (to assert
  // ordering) AND the sourcePath (to assert each step is built with the path it stages the dump at).
  const descriptor = (label: string, sourcePath: string): ExecutionDescriptor => ({
    image: label,
    command: [label, sourcePath],
    env: {},
    outputKind: "directory",
  });

  it("restores globals BEFORE the per-database artifact, each built with its sourcePath", () => {
    const steps = planRestoreSteps(
      "k/artifact.bin",
      (sourcePath) => descriptor("restore", sourcePath),
      "k/globals.bin",
      (sourcePath) => descriptor("globals", sourcePath),
    );
    expect(steps.map((s) => s.key)).toEqual(["k/globals.bin", "k/artifact.bin"]);

    // The builders are deferred: each step wires the mount path THROUGH to its descriptor.
    const globals = steps[0]?.buildDescriptor("/stage/globals");
    expect(globals?.image).toBe("globals");
    expect(globals?.command).toEqual(["globals", "/stage/globals"]);

    const artifact = steps[1]?.buildDescriptor("/stage/artifact");
    expect(artifact?.image).toBe("restore");
    expect(artifact?.command).toEqual(["restore", "/stage/artifact"]);
  });

  it("is a single step when there is no globals object", () => {
    const steps = planRestoreSteps(
      "k/artifact.bin",
      (sourcePath) => descriptor("restore", sourcePath),
      null,
      () => null,
    );
    expect(steps.map((s) => s.key)).toEqual(["k/artifact.bin"]);
    expect(steps[0]?.buildDescriptor("/stage/x").command).toEqual(["restore", "/stage/x"]);
  });
});

// Mirrors backup-wiring.test.ts's capturing-runner pattern: no Docker/S3, only the crypto/stream
// pipeline is real (a real gzip+age-encrypted ciphertext, decrypted+gunzipped onto a real mkdtemp'd
// staging dir), so runRestorePipeline's mount-threading and reservation lifecycle run for real.
describe("runRestorePipeline — extra-mount threading and reservation lifecycle", () => {
  let stagingDir: string;
  let stagingCleanupCalls: number;
  // What the reserved dir still held at the moment the reservation was released. The per-step
  // finally removes the decrypted dump BEFORE this runs, so a non-empty listing here means a
  // cleartext dump outlived the step that created it.
  let stagingContentsAtCleanup: string[];

  beforeEach(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), "schrodump-restore-pipeline-"));
    stagingCleanupCalls = 0;
    stagingContentsAtCleanup = [];
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  const reserveStaging = (): Promise<{ dir: string; cleanup: () => Promise<void> }> =>
    Promise.resolve({
      dir: stagingDir,
      cleanup: async () => {
        stagingCleanupCalls++;
        stagingContentsAtCleanup = await readdir(stagingDir);
        await rm(stagingDir, { recursive: true, force: true });
      },
    });

  const restoreDescriptor = (sourcePath: string): ExecutionDescriptor => ({
    image: "restore",
    command: ["restore", sourcePath],
    env: {},
    outputKind: "directory",
  });

  // gzip -> age-encrypt a plaintext, mirroring backup-wiring's encryptStream — the inverse of what
  // restoreOne does on the way in (decrypt -> gunzip), so the real pipeline has real bytes to consume.
  async function encryptedGzip(plaintext: string, recipient: string): Promise<Readable> {
    const gzipped = Readable.from([plaintext]).pipe(createGzip());
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const source = Readable.toWeb(gzipped) as ReadableStream<Uint8Array>;
    return Readable.fromWeb(await encrypter.encrypt(source));
  }

  function fakeDriver(get: () => Promise<Readable>): StorageDriver {
    const unused = (): never => {
      throw new Error("not used in this test");
    };
    return { put: unused, get: () => get(), head: unused, delete: unused, list: unused, canary: unused };
  }

  function capturingRunner(capture: RunOptions[]): Runner {
    return {
      run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
        capture.push(opts);
        return Promise.resolve({ exitCode: 0, stderr: "", durationMs: 1 });
      },
      withEphemeralService: () => Promise.reject(new Error("not used in this test")),
    };
  }

  it("mounts [dumpMount, configMount] when provideExtraMounts returns a mount (mongo)", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];
    const configMount: RunMount = {
      source: "/scratch/job-1/mongo-config.yaml",
      target: "/etc/schrodump/mongodb.yaml",
      readOnly: true,
    };

    const ok = await runRestorePipeline({
      driver: fakeDriver(() => encryptedGzip("hello", recipient)),
      runner: capturingRunner(capture),
      bucketKey: "artifact.bin",
      globalsKey: null,
      ageIdentity: identity,
      network: "schrodump_targets",
      timeoutMs: 1000,
      correlationId: "job-1",
      buildRestoreDescriptor: restoreDescriptor,
      buildGlobalsRestoreDescriptor: () => null,
      reserveStaging,
      provideExtraMounts: () => Promise.resolve({ mounts: [configMount], cleanup: () => Promise.resolve() }),
    });

    expect(ok).toBe(true);
    const mounts = capture[0]?.mounts ?? [];
    expect(mounts).toHaveLength(2);
    expect(mounts[0]?.readOnly).toBe(true);
    expect(mounts[0]?.source.startsWith(stagingDir)).toBe(true);
    expect(mounts[1]).toEqual(configMount);
  });

  it("mounts only [dumpMount] when there is no provideExtraMounts (non-mongo)", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];

    const ok = await runRestorePipeline({
      driver: fakeDriver(() => encryptedGzip("hello", recipient)),
      runner: capturingRunner(capture),
      bucketKey: "artifact.bin",
      globalsKey: null,
      ageIdentity: identity,
      network: "schrodump_targets",
      timeoutMs: 1000,
      correlationId: "job-1",
      buildRestoreDescriptor: restoreDescriptor,
      buildGlobalsRestoreDescriptor: () => null,
      reserveStaging,
    });

    expect(ok).toBe(true);
    expect(capture[0]?.mounts).toHaveLength(1);
  });

  // Locks Finding 1: a throw from provideExtraMounts (ENOSPC/EIO writing mongo's `--config` file)
  // must still release the staging reservation — before the fix, the await sat OUTSIDE the try whose
  // finally does staging.cleanup(), so the throw skipped cleanup entirely and leaked the scratch
  // semaphore slot (wedging every future staged op under a small SCHRODUMP_MAX_CONCURRENT_STAGED).
  it("releases the staging reservation when provideExtraMounts throws", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];

    await expect(
      runRestorePipeline({
        driver: fakeDriver(() => encryptedGzip("hello", recipient)),
        runner: capturingRunner(capture),
        bucketKey: "artifact.bin",
        globalsKey: null,
        ageIdentity: identity,
        network: "schrodump_targets",
        timeoutMs: 1000,
        correlationId: "job-1",
        buildRestoreDescriptor: restoreDescriptor,
        buildGlobalsRestoreDescriptor: () => null,
        reserveStaging,
        provideExtraMounts: () => Promise.reject(new Error("ENOSPC materializing the config file")),
      }),
    ).rejects.toThrow(/ENOSPC/);

    // The finally still ran: the reservation was released (its semaphore slot freed) even though
    // provideExtraMounts threw before any restore executor ran.
    expect(stagingCleanupCalls).toBe(1);
    expect(capture).toHaveLength(0);
  });

  // FIX: deps.signal used to be consulted at exactly one place — the runner.run call. Everything
  // before it, including the decrypt -> gunzip -> scratch-file write that CREATES the cleartext, was
  // signal-blind, so a shutdown mid-download waited out the whole write (minutes for a multi-GB
  // artifact) before the finally that removes that file could run. The grace expires first.
  it("aborts the decrypt-to-scratch write mid-flight and leaves no cleartext behind", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];
    const controller = new AbortController();

    // Real ciphertext on a source that never ends: the decrypt-to-scratch write stays in flight
    // exactly as it does for a large artifact, giving the abort something real to interrupt.
    // Without the signal on that pipeline nothing ever settles and this test times out.
    const held = new PassThrough();
    held.on("error", () => undefined);
    (await encryptedGzip("hello", recipient)).pipe(held, { end: false });

    const promise = runRestorePipeline({
      driver: fakeDriver(() => Promise.resolve(held)),
      runner: capturingRunner(capture),
      bucketKey: "artifact.bin",
      globalsKey: null,
      ageIdentity: identity,
      network: "schrodump_targets",
      timeoutMs: 1000,
      correlationId: "job-1",
      signal: controller.signal,
      buildRestoreDescriptor: restoreDescriptor,
      buildGlobalsRestoreDescriptor: () => null,
      reserveStaging,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    // RESTORE_ABORTED, never RESTORE_DECRYPT_FAILED: a shutdown observed nothing about the
    // artifact, so verify must classify it INCONCLUSIVE rather than condemn it.
    await expect(promise).rejects.toMatchObject({ code: "RESTORE_ABORTED" });
    // No restore executor ever ran, and the staged cleartext was gone before the reservation was
    // released — the abort routed into the finally instead of waiting the write out.
    expect(capture).toHaveLength(0);
    expect(stagingCleanupCalls).toBe(1);
    expect(stagingContentsAtCleanup).toEqual([]);
  });

  // Same claim as backup-wiring's: the shutdown signal has to ARRIVE at the runner, by identity.
  // A call site that dropped it would leave a restore container running past the shutdown with
  // nothing failing.
  it("hands the shutdown signal through to the restore run", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];
    const { signal } = new AbortController();

    const ok = await runRestorePipeline({
      driver: fakeDriver(() => encryptedGzip("hello", recipient)),
      runner: capturingRunner(capture),
      bucketKey: "artifact.bin",
      globalsKey: null,
      ageIdentity: identity,
      network: "schrodump_targets",
      timeoutMs: 1000,
      correlationId: "job-1",
      signal,
      buildRestoreDescriptor: restoreDescriptor,
      buildGlobalsRestoreDescriptor: () => null,
      reserveStaging,
    });

    expect(ok).toBe(true);
    expect(capture[0]?.signal).toBe(signal);
  });

  // Postgres restores globals and then the database. An abort between the two must not begin the
  // second step: it would stage a fresh cleartext dump the grace has no budget left to remove.
  it("refuses to begin a step once the shutdown signal has fired, staging nothing", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];

    await expect(
      runRestorePipeline({
        driver: fakeDriver(() => encryptedGzip("hello", recipient)),
        runner: capturingRunner(capture),
        bucketKey: "artifact.bin",
        globalsKey: null,
        ageIdentity: identity,
        network: "schrodump_targets",
        timeoutMs: 1000,
        correlationId: "job-1",
        signal: AbortSignal.abort(),
        buildRestoreDescriptor: restoreDescriptor,
        buildGlobalsRestoreDescriptor: () => null,
        reserveStaging,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ABORTED" });

    expect(capture).toHaveLength(0);
    // The reservation was still released, and nothing was ever decrypted into it.
    expect(stagingCleanupCalls).toBe(1);
    expect(stagingContentsAtCleanup).toEqual([]);
  });
});
