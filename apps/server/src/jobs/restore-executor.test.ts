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
    const p = restoreParamsOf({
      target: "DATABASE",
      confirmExistingDatabase: true,
      triggeredByUserId: "u1",
    });
    expect(p).toEqual({
      target: "DATABASE",
      confirmExistingDatabase: true,
      triggeredByUserId: "u1",
    });
  });

  it("throws on missing/garbage params (a RESTORE job must carry them)", () => {
    expect(() => restoreParamsOf(null)).toThrow();
    expect(() => restoreParamsOf({ target: "NOPE" })).toThrow();
    // A blank user id is not a valid trigger — never audit a restore to nobody.
    expect(() =>
      restoreParamsOf({
        target: "DATABASE",
        confirmExistingDatabase: false,
        triggeredByUserId: "",
      }),
    ).toThrow();
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

  beforeEach(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), "schrodump-restore-pipeline-"));
    stagingCleanupCalls = 0;
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  const reserveStaging = (): Promise<{ dir: string; cleanup: () => Promise<void> }> =>
    Promise.resolve({
      dir: stagingDir,
      cleanup: async () => {
        stagingCleanupCalls++;
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
    return {
      put: unused,
      get: () => get(),
      head: unused,
      delete: unused,
      list: unused,
      canary: unused,
    };
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
      provideExtraMounts: () =>
        Promise.resolve({ mounts: [configMount], cleanup: () => Promise.resolve() }),
    });

    expect(ok).toBe(true);
    const mounts = capture[0]?.mounts ?? [];
    expect(mounts).toHaveLength(2);
    expect(mounts[0]?.readOnly).toBe(true);
    expect(mounts[0]?.source.startsWith(stagingDir)).toBe(true);
    expect(mounts[1]).toEqual(configMount);
  });

  it("refuses to start a step once the shutdown signal has tripped, and stages no cleartext", async () => {
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
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ABORTED" });

    // The point of the code: no executor ran, and nothing decrypted was left on the volume.
    expect(capture).toHaveLength(0);
    expect(await readdir(stagingDir).catch(() => [])).toEqual([]);
    expect(stagingCleanupCalls).toBe(1);
  });

  it("cancels the decrypt-to-scratch write mid-flight and leaves no cleartext behind", async () => {
    // The one the step-loop guard does NOT cover: the signal trips while the decrypted dump is
    // already being written. On a multi-GB artifact that write is the longest phase of a restore
    // and the most likely to be in flight at shutdown; without the signal on the pipeline itself,
    // the `finally` that removes the file waits for the write to finish on its own.
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const controller = new AbortController();
    const capture: RunOptions[] = [];

    // Real ciphertext, delivered and then held open — the stream never ends on its own.
    const stalled = new PassThrough();
    void (async () => {
      for await (const chunk of await encryptedGzip("hello", recipient)) {
        stalled.write(chunk as Buffer);
      }
    })();

    const promise = runRestorePipeline({
      driver: fakeDriver(() => Promise.resolve(stalled)),
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
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 25));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "RESTORE_ABORTED" });
    expect(capture).toHaveLength(0); // never reached the executor
    expect(await readdir(stagingDir).catch(() => [])).toEqual([]);
  });

  it("extracts a STAGED artifact and restores from the directory, not the tar", async () => {
    // A STAGED artifact is a TAR of the directory dump (see buildArchiveStaging). Restoring it
    // means unpacking first: handing pg_restore/myloader the tar itself would fail, and mounting
    // the file where a directory is expected is the mirror of the bug that made STAGED backups
    // upload nothing.
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];

    const ok = await runRestorePipeline({
      driver: fakeDriver(() => encryptedGzip("tar-bytes", recipient)),
      runner: capturingRunner(capture),
      bucketKey: "artifact.bin",
      globalsKey: null,
      ageIdentity: identity,
      network: "schrodump_targets",
      timeoutMs: 1000,
      correlationId: "job-1",
      executionMode: "STAGED",
      buildRestoreDescriptor: restoreDescriptor,
      buildGlobalsRestoreDescriptor: () => null,
      reserveStaging,
    });

    expect(ok).toBe(true);
    // Two runs: extract, then restore.
    expect(capture).toHaveLength(2);
    // The restore's source mount is a DIRECTORY the extract step filled, never the tar.
    const restoreMounts = capture[1]?.mounts ?? [];
    expect(restoreMounts[0]?.source).not.toMatch(/\.tar$/);
    expect(restoreMounts[0]?.readOnly).toBe(true);
  });

  it("forwards the shutdown signal to the runner, so a run in flight is cancellable", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];
    const signal = new AbortController().signal;

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
      signal,
    });

    expect(ok).toBe(true);
    expect(capture[0]?.signal).toBe(signal);
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

  // Task 3: the shutdown AbortSignal is a construction-time dependency (bound once at
  // createJobExecutor) that must ride along on every container-creating run, so the runner can
  // force-remove the container on abort. Undefined when nothing was passed — behavior unchanged.
  it("forwards the shutdown signal into the restore executor's run options", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const capture: RunOptions[] = [];
    const controller = new AbortController();

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
      signal: controller.signal,
    });

    expect(ok).toBe(true);
    expect(capture[0]?.signal).toBe(controller.signal);
  });
});
