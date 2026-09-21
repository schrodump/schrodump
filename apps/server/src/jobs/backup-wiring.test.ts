// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Unit test for the one invariant createBackupPorts must never break: a non-zero dump exit has to
// fail the upload so runBackupJob marks the job FAILED and persists NO artifact. No Docker/S3 —
// the Runner and StorageDriver are fakes; only the crypto/stream pipeline is real.

import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import type { PutOptions, PutResult, StorageDriver } from "@schrodump/storage/driver";
import type { RunOptions, RunResult, Runner } from "@schrodump/runner/runner";
import { createBackupPorts, type BackupWiringDeps } from "./backup-wiring.js";
import { runBackupJob, type BackupOutcome, type ProbeResult } from "./backup.js";

const PROBE: ProbeResult = {
  serverVersionNum: 160002,
  scope: { databases: ["app"], schemas: [], collections: [] },
  estimatedBytes: 100,
};

const DESCRIPTOR: ExecutionDescriptor = {
  image: "img",
  command: ["dump"],
  env: {},
  outputKind: "stdout",
};

// Mimics the real DockerRunner: pipes container stdout to opts.stdout and ends it, then reports the
// container's StatusCode as exitCode.
// Shared with the size assertion below, so the number the test expects and the bytes the fixture
// writes cannot drift apart.
const FIXTURE_PAYLOAD = "-- pg_dump fixture payload\n";

function fakeRunner(exitCode: number): Runner {
  return {
    run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
      // Writes real bytes before ending. It used to only end the stream, which modelled a dump that
      // produced NOTHING as a success — the very shape that shipped an empty artifact under a
      // SUCCEEDED job. A fixture that cannot tell those apart cannot catch them.
      opts.stdout?.write(Buffer.from(FIXTURE_PAYLOAD));
      opts.stdout?.end();
      return Promise.resolve({ exitCode, stderr: "", durationMs: 1 });
    },
    // Backup never provisions an ephemeral service; satisfy the interface without exercising it.
    withEphemeralService: () => Promise.reject(new Error("not used in backup tests")),
  };
}

// Consumes the ciphertext stream to completion, the way a real multipart upload does, and resolves
// — never inspects the bytes. `deletedKeys` records what the
// run-failure cleanup path (finding #2) actually deletes; `putBehavior` lets a test simulate a
// transient put() failure (finding #1) instead of the default happy-path put.
function fakeDriver(options?: {
  deletedKeys?: string[];
  putBehavior?: "succeed" | "reject";
}): StorageDriver {
  const unused = (): never => {
    throw new Error("not used in this test");
  };
  const deletedKeys = options?.deletedKeys ?? [];
  const putBehavior = options?.putBehavior ?? "succeed";
  return {
    put: (_key: string, body: Readable): Promise<PutResult> =>
      new Promise((resolve, reject) => {
        if (putBehavior === "reject") {
          // Drain the stream so encryptStream's writer doesn't hang, then fail as if S3 had a
          // transient error — the object was never durably written.
          body.resume();
          body.on("end", () => reject(new Error("put failed: transient S3 error")));
          body.on("error", reject);
          return;
        }
        body.on("error", reject);
        // A real uploader READS the stream. This used to wait for "end" without consuming, which
        // only ever arrived because uploadEncrypted had a `data` listener on the same stream
        // putting it in flowing mode — the very defect that let 9.4 GB reach a bucket as 877
        // bytes. A fixture that depends on the bug cannot fail when the bug is fixed.
        body.resume();
        body.on("end", () => resolve({ etag: "e", sizeBytes: 0, checksum: null }));
      }),
    get: unused,
    head: unused,
    delete: (keys: string[]): Promise<void> => {
      deletedKeys.push(...keys);
      return Promise.resolve();
    },
    list: unused,
    canary: unused,
  };
}

// A dump whose stdout breaks partway through: bytes flow, then the stream dies. This is the shape
// that shipped — a 9.4 GB production dump reached the bucket as an 877-byte envelope with the job
// reported SUCCEEDED, because `.pipe()` drops a middle stage's error and closes the destination
// cleanly. Only the FULL_RESTORE verify caught it, by restoring the artifact and finding no tables.
function fakeBrokenStreamRunner(): Runner {
  return {
    run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
      opts.stdout?.write(Buffer.from("-- pg_dump fixture payload\n"));
      setImmediate(() => {
        opts.stdout?.destroy(new Error("the dump stream broke mid-transfer"));
      });
      // Exit 0, like the tool that never noticed. Success has to be decided by the DATA arriving,
      // not by the process not complaining — which is this project's whole argument.
      return Promise.resolve({ exitCode: 0, stderr: "", durationMs: 1 });
    },
    withEphemeralService: () => Promise.reject(new Error("not used in backup tests")),
  };
}

// Mimics run() rejecting outright — e.g. createContainer 404ing on a missing executor image —
// while still ending stdout (b49c8f7), so the consumer's pipeline unblocks instead of hanging.
function fakeRejectingRunner(reason: Error): Runner {
  return {
    run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
      opts.stdout?.end();
      return Promise.reject(reason);
    },
    withEphemeralService: () => Promise.reject(new Error("not used in backup tests")),
  };
}

async function makeDeps(
  exitCode: number,
  options?: { runner?: Runner; driver?: StorageDriver },
): Promise<{ deps: BackupWiringDeps; recipient: string }> {
  const recipient = await identityToRecipient(await generateX25519Identity());
  const deps: BackupWiringDeps = {
    jobId: "job-1",
    organizationId: "org-1",
    engine: "postgres",
    runner: options?.runner ?? fakeRunner(exitCode),
    driver: options?.driver ?? fakeDriver(),
    network: "schrodump_targets",
    prefix: "backups",
    timeoutMs: 1000,
    setState: () => Promise.resolve(),
    probe: () => Promise.resolve(PROBE),
    reserveScratch: () => Promise.resolve({ release: () => Promise.resolve() }),
    resolveRecipients: () => Promise.resolve({ recipients: [recipient], keyIds: ["k"] }),
    buildDumpDescriptor: () => DESCRIPTOR,
    buildGlobalsDescriptor: () => null,
    buildManifest: () => {
      throw new Error("not used in this test");
    },
    persistArtifact: () => Promise.resolve("artifact-1"),
  };
  return { deps, recipient };
}

describe("createBackupPorts.executeAndUpload", () => {
  // STAGED had three independent breaks, all of which had to be fixed at once for the mode to mean
  // anything: the staging directory was never MOUNTED into the dump container (the directory dump
  // landed in the container's own filesystem and vanished with it), nothing ever turned that
  // directory back into a stream, and the upload read stdout that a directory dump never writes.
  it("runs the dump into a mounted staging directory, then uploads a tar of it", async () => {
    const capture: RunOptions[] = [];
    const stagedRunner: Runner = {
      run: (descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
        capture.push(opts);
        // Only the archive step writes to stdout; the dump writes to its mounted directory.
        if (descriptor.command[0] === "tar") {
          opts.stdout?.write(Buffer.from("tar-bytes-of-the-directory-dump"));
        }
        opts.stdout?.end();
        return Promise.resolve({ exitCode: 0, stderr: "", durationMs: 1 });
      },
      withEphemeralService: () => Promise.reject(new Error("not used")),
    };

    const { deps, recipient } = await makeDeps(0, { runner: stagedRunner });
    const ports = createBackupPorts({ ...deps, stagingPath: "/scratch/job-1" });
    const upload = await ports.executeAndUpload({
      mode: "STAGED",
      parallelism: 4,
      probe: PROBE,
      recipients: { recipients: [recipient], keyIds: ["k"] },
    });

    expect(capture).toHaveLength(2);
    // The dump gets the staging directory mounted read-write, at the same path it was told to
    // write to — otherwise -Fd writes inside the container and the bytes die with it.
    expect(capture[0]?.mounts).toContainEqual({
      source: "/scratch/job-1",
      target: "/scratch/job-1",
      readOnly: false,
    });
    expect(capture[0]?.stdout).toBeUndefined();
    // The archive step reads that same directory and is the one whose stdout becomes the artifact.
    expect(capture[1]?.stdout).toBeDefined();
    expect(upload.sizeCompressedBytes).toBeGreaterThan(0);
  });

  // A dump tool that exits 0 having written NOTHING is the shape that shipped an empty artifact
  // under a SUCCEEDED job (STAGED wrote to a directory while the upload read stdout). The check is
  // deliberately not a size heuristic: zero bytes is unambiguous, needs no threshold to tune, and
  // no real dump of any engine produces it — even an empty database emits a header.
  it("rejects a dump that exits 0 without producing a single byte", async () => {
    const emptyRunner: Runner = {
      run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
        opts.stdout?.end(); // exits clean, writes nothing
        return Promise.resolve({ exitCode: 0, stderr: "", durationMs: 1 });
      },
      withEphemeralService: () => Promise.reject(new Error("not used")),
    };
    const deletedKeys: string[] = [];
    const { deps, recipient } = await makeDeps(0, {
      runner: emptyRunner,
      driver: fakeDriver({ deletedKeys }),
    });
    const ports = createBackupPorts(deps);
    await expect(
      ports.executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow(/no data/i);
    // And the empty object it already wrote must not outlive the job as an orphan, exactly as the
    // non-zero-exit path does.
    expect(deletedKeys).toEqual(["backups/org-1/job-1/artifact.bin"]);
  });

  it("fails the job when the dump stream breaks mid-transfer, instead of uploading what survived", async () => {
    // The defect this replaces did not throw: it uploaded the truncated remainder, called it a
    // success, and left an artifact that only a full restore could expose as empty.
    const { deps, recipient } = await makeDeps(0, { runner: fakeBrokenStreamRunner() });
    const ports = createBackupPorts(deps);

    await expect(
      ports.executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow();
  });

  it("records the bytes the dump actually produced as sizeRawBytes, not the probe's server-wide estimate", async () => {
    // The estimate is the probe's sum over EVERY database on the server. Stored on the artifact it
    // said "9.4 GB" over an 876-byte envelope that held no tables — the one number an operator uses
    // to judge whether a backup is plausible, describing a different thing entirely.
    const { deps, recipient } = await makeDeps(0);

    const result = await createBackupPorts(deps).executeAndUpload({
      mode: "STREAM",
      parallelism: 1,
      probe: PROBE,
      recipients: { recipients: [recipient], keyIds: ["k"] },
    });

    expect(result.sizeRawBytes).toBe(Buffer.byteLength(FIXTURE_PAYLOAD));
    expect(result.sizeRawBytes).not.toBe(PROBE.estimatedBytes);
  });

  it("rejects when the dump exits non-zero (no VERIFIED artifact can result)", async () => {
    const deletedKeys: string[] = [];
    const { deps, recipient } = await makeDeps(1, { driver: fakeDriver({ deletedKeys }) });
    const ports = createBackupPorts(deps);
    await expect(
      ports.executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow(/exit code 1/);
    // b49c8f7 makes put() complete (not hang) on a failed run, which writes a 0-byte object with no
    // Artifact row behind it; row-based retention can never reclaim it, so the orphan must be
    // deleted here or it is permanent.
    expect(deletedKeys).toEqual(["backups/org-1/job-1/artifact.bin"]);
  });

  // Regression for the runner fix b49c8f7: a pre-stream run() rejection (not just a non-zero exit)
  // now lets put() complete instead of hanging forever, which means uploadEncrypted has TWO settled
  // promises to account for. If the run's rejection were left unawaited it would surface as an
  // unhandled rejection and crash the worker process (no global handler in apps/server) instead of
  // just failing the job — this is finding #1.
  it("surfaces the run's rejection (not a put error), deletes the orphan, and never leaves an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const deletedKeys: string[] = [];
      const runReason = new Error("createContainer failed: no such image (404)");
      const { deps, recipient } = await makeDeps(0, {
        runner: fakeRejectingRunner(runReason),
        driver: fakeDriver({ deletedKeys }),
      });
      const ports = createBackupPorts(deps);
      await expect(
        ports.executeAndUpload({
          mode: "STREAM",
          parallelism: 1,
          probe: PROBE,
          recipients: { recipients: [recipient], keyIds: ["k"] },
        }),
      ).rejects.toBe(runReason);
      expect(deletedKeys).toEqual(["backups/org-1/job-1/artifact.bin"]);
      // Give any stray unhandled rejection a microtask/macrotask to surface before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // When the run fails, its error is the root cause (e.g. the 404 above) and must win even if the
  // cleanup put() also failed for an unrelated reason (a transient S3 error) — the put error would
  // point at the wrong layer and hide what actually broke the job.
  it("prefers the run's error over a put failure when both fail", async () => {
    const deletedKeys: string[] = [];
    const { deps, recipient } = await makeDeps(1, {
      driver: fakeDriver({ deletedKeys, putBehavior: "reject" }),
    });
    const ports = createBackupPorts(deps);
    await expect(
      ports.executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow(/exit code 1/);
    expect(deletedKeys).toEqual(["backups/org-1/job-1/artifact.bin"]);
  });

  // The inverse of finding #1's fix: when the run succeeds, there is no run error to prefer, so a
  // put failure must surface as-is — and there is no orphan to clean up, since put() never
  // completed a durable write.
  it("surfaces the put error when the run succeeds but put fails, and deletes nothing", async () => {
    const deletedKeys: string[] = [];
    const { deps, recipient } = await makeDeps(0, {
      driver: fakeDriver({ deletedKeys, putBehavior: "reject" }),
    });
    const ports = createBackupPorts(deps);
    await expect(
      ports.executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow(/put failed/);
    expect(deletedKeys).toEqual([]);
  });

  it("resolves with checksum/size on a clean (exit 0) dump", async () => {
    const { deps, recipient } = await makeDeps(0);
    const ports = createBackupPorts(deps);
    const upload = await ports.executeAndUpload({
      mode: "STREAM",
      parallelism: 1,
      probe: PROBE,
      recipients: { recipients: [recipient], keyIds: ["k"] },
    });
    expect(upload.checksumAlgorithm).toBe("sha256");
    expect(upload.checksum).toMatch(/^[0-9a-f]+$/);
    expect(upload.sizeCompressedBytes).toBeGreaterThan(0);
  });

  // The mongo `--config` credential mount is the one thing this task wires into the dump run: the
  // password must ride in on a mount, never argv. Capture what the runner actually received.
  it("mounts configMount into the dump run when set (mongo), and nothing otherwise", async () => {
    const capture: RunOptions[] = [];
    const capturingRunner: Runner = {
      run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
        capture.push(opts);
        opts.stdout?.write(Buffer.from("-- fixture payload\n"));
        opts.stdout?.end();
        return Promise.resolve({ exitCode: 0, stderr: "", durationMs: 1 });
      },
      withEphemeralService: () => Promise.reject(new Error("not used")),
    };

    const run = async (configMount?: RunOptions["mounts"][number]): Promise<void> => {
      const { deps, recipient } = await makeDeps(0);
      const ports = createBackupPorts({
        ...deps,
        runner: capturingRunner,
        ...(configMount !== undefined ? { configMount } : {}),
      });
      await ports.executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      });
    };

    const mount = {
      source: "/scratch/job-1/mongo-config.yaml",
      target: "/etc/schrodump/mongodb.yaml",
      readOnly: true,
    };
    await run(mount);
    expect(capture[0]?.mounts).toEqual([mount]);

    capture.length = 0;
    await run(undefined);
    expect(capture[0]?.mounts).toEqual([]);
  });

  // The scratch release waits on put() settling (Promise.allSettled below the upload), and
  // lib-storage's Upload is not signal-aware on its own — so without the signal reaching the driver
  // an aborted STAGED backup holds its cleartext scratch directory until the multipart upload
  // finishes on its own, which on a slow link outlasts the shutdown grace.
  it("forwards the shutdown signal into the upload options", async () => {
    const capture: PutOptions[] = [];
    const signal = new AbortController().signal;
    const capturingDriver: StorageDriver = {
      ...fakeDriver(),
      put: (_key: string, body: Readable, opts: PutOptions): Promise<PutResult> => {
        capture.push(opts);
        body.resume();
        return new Promise((resolve) =>
          body.on("end", () => resolve({ etag: "e", sizeBytes: 1, checksum: null })),
        );
      },
    };

    const { deps, recipient } = await makeDeps(0, { driver: capturingDriver });
    const ports = createBackupPorts({ ...deps, signal });
    await ports.executeAndUpload({
      mode: "STREAM",
      parallelism: 1,
      probe: PROBE,
      recipients: { recipients: [recipient], keyIds: ["k"] },
    });

    expect(capture.length).toBeGreaterThan(0);
    expect(capture[0]?.signal).toBe(signal);
  });

  // Task 3: the shutdown AbortSignal is a construction-time dependency (bound once at
  // createJobExecutor) that must ride along on every container-creating run, so the runner can
  // force-remove the container on abort. Undefined when nothing was passed — behavior unchanged.
  it("forwards the shutdown signal into the dump run options", async () => {
    const capture: RunOptions[] = [];
    const capturingRunner: Runner = {
      run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
        capture.push(opts);
        opts.stdout?.write(Buffer.from("-- fixture payload\n"));
        opts.stdout?.end();
        return Promise.resolve({ exitCode: 0, stderr: "", durationMs: 1 });
      },
      withEphemeralService: () => Promise.reject(new Error("not used")),
    };
    const controller = new AbortController();
    const { deps, recipient } = await makeDeps(0);
    const ports = createBackupPorts({
      ...deps,
      runner: capturingRunner,
      signal: controller.signal,
    });

    await ports.executeAndUpload({
      mode: "STREAM",
      parallelism: 1,
      probe: PROBE,
      recipients: { recipients: [recipient], keyIds: ["k"] },
    });

    expect(capture[0]?.signal).toBe(controller.signal);
  });
});

// A dump tool that failed says why on stderr, and the runner has already captured and redacted it.
// The job's reason used to carry the exit code alone — "dump execution failed (exit code 1)" for a
// managed postgres answering `permission denied for table pg_authid`, the one sentence that says
// what to change.
describe("createBackupPorts — a failed dump says what the tool said", () => {
  const STDERR =
    'pg_dump: error: connection to server at "db" failed: FATAL:  role "backup" does not exist';

  function failingRunner(stderr: string): Runner {
    return {
      run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
        opts.stdout?.end();
        return Promise.resolve({ exitCode: 1, stderr, durationMs: 1 });
      },
      withEphemeralService: () => Promise.reject(new Error("not used")),
    };
  }

  it("keeps the stderr of a STREAM dump in the failure", async () => {
    const { deps, recipient } = await makeDeps(1, { runner: failingRunner(STDERR) });
    await expect(
      createBackupPorts(deps).executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow(`dump execution failed (exit code 1): ${STDERR}`);
  });

  it("keeps the stderr of a STAGED dump in the failure", async () => {
    const { deps, recipient } = await makeDeps(1, { runner: failingRunner(STDERR) });
    await expect(
      createBackupPorts({ ...deps, stagingPath: "/scratch/job-1" }).executeAndUpload({
        mode: "STAGED",
        parallelism: 2,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow(`dump execution failed (exit code 1): ${STDERR}`);
  });
});

// The whole backup, through the real ports, for the engine that writes three objects. Every step
// after the database dump's upload can fail — the globals dump (a managed postgres refusing
// pg_authid), the manifest write, the row insert — and each used to leave what came before it in
// the bucket with no row: a 154 KB artifact.bin under a FAILED job, found by listing the bucket.
describe("runBackupJob over createBackupPorts — a failure after the upload leaves nothing behind", () => {
  const PREFIX = "backups/org-1/job-1";
  const PG_DUMPALL_STDERR =
    "pg_dumpall: error: query failed: ERROR:  permission denied for table pg_authid";

  const GLOBALS: ExecutionDescriptor = {
    image: "postgres:16-alpine",
    command: ["pg_dumpall", "--globals-only"],
    env: {},
    outputKind: "stdout",
  };

  // The database dump succeeds; the globals dump does whatever the case asks of it.
  function runnerWithGlobals(globals: { exitCode: number; stderr: string }): Runner {
    return {
      run: (descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
        const isGlobals = descriptor.command[0] === "pg_dumpall";
        if (!isGlobals || globals.exitCode === 0) opts.stdout?.write(Buffer.from(FIXTURE_PAYLOAD));
        opts.stdout?.end();
        return Promise.resolve(
          isGlobals
            ? { exitCode: globals.exitCode, stderr: globals.stderr, durationMs: 1 }
            : { exitCode: 0, stderr: "", durationMs: 1 },
        );
      },
      withEphemeralService: () => Promise.reject(new Error("not used")),
    };
  }

  // Records what reached the bucket and what left it; `refuse` fails the put of one key.
  function recordingDriver(refuse?: (key: string) => boolean): {
    driver: StorageDriver;
    put: string[];
    deleted: string[];
  } {
    const put: string[] = [];
    const deleted: string[] = [];
    return {
      put,
      deleted,
      driver: {
        ...fakeDriver({ deletedKeys: deleted }),
        put: (key: string, body: Readable): Promise<PutResult> => {
          put.push(key);
          if (refuse?.(key) === true) {
            body.resume();
            return Promise.reject(new Error(`put failed: ${key}`));
          }
          return new Promise((resolve, reject) => {
            body.on("error", reject);
            body.resume();
            body.on("end", () => resolve({ etag: "e", sizeBytes: 0, checksum: null }));
          });
        },
      },
    };
  }

  async function backup(options: {
    globals?: { exitCode: number; stderr: string };
    refuse?: (key: string) => boolean;
    persist?: () => Promise<string>;
  }): Promise<{
    outcome: BackupOutcome;
    put: string[];
    deleted: string[];
    reason: string | undefined;
    persisted: boolean;
  }> {
    const { driver, put, deleted } = recordingDriver(options.refuse);
    const { deps } = await makeDeps(0, {
      runner: runnerWithGlobals(options.globals ?? { exitCode: 0, stderr: "" }),
      driver,
    });
    let reason: string | undefined;
    let persisted = false;
    const ports = createBackupPorts({
      ...deps,
      setState: (state, why) => {
        if (state === "FAILED") reason = why;
        return Promise.resolve();
      },
      buildGlobalsDescriptor: () => GLOBALS,
      buildManifest: ({ probe, mode, recipients, upload }) => ({
        manifestVersion: 1,
        jobId: "job-1",
        organizationId: "org-1",
        engine: "postgres",
        serverVersionNum: probe.serverVersionNum,
        toolVersion: "test",
        executionMode: mode,
        parallelism: 1,
        scope: probe.scope,
        sizeRawBytes: upload.sizeRawBytes,
        sizeCompressedBytes: upload.sizeCompressedBytes,
        checksumAlgorithm: upload.checksumAlgorithm,
        checksum: upload.checksum,
        compression: "gzip",
        encryption: { algorithm: "age", keyIds: recipients.keyIds },
        dependsOn: [],
        createdAt: new Date(0).toISOString(),
        durationMs: 0,
      }),
      persistArtifact: () => {
        persisted = true;
        return options.persist?.() ?? Promise.resolve("artifact-1");
      },
    });
    const outcome = await runBackupJob(
      {
        jobId: "job-1",
        organizationId: "org-1",
        requestedParallelism: 1,
        scratchConfigured: false,
        singleDatabaseStagingScope: null,
      },
      ports,
    );
    return { outcome, put, deleted, reason, persisted };
  }

  it("deletes the uploaded database dump when the server refuses the globals dump, and says why", async () => {
    const result = await backup({ globals: { exitCode: 1, stderr: PG_DUMPALL_STDERR } });

    expect(result.outcome.ok).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.put).toEqual([`${PREFIX}/artifact.bin`, `${PREFIX}/globals.bin`]);
    expect(new Set(result.deleted)).toEqual(new Set(result.put));
    // The step AND the tool's words: an operator reading this knows it was the globals, and why.
    expect(result.reason).toBe(`globals dump execution failed (exit code 1): ${PG_DUMPALL_STDERR}`);
  });

  it("deletes the database dump and the globals when the manifest cannot be written", async () => {
    const result = await backup({ refuse: (key) => key.endsWith("/manifest.json") });

    expect(result.outcome.ok).toBe(false);
    expect(new Set(result.deleted)).toEqual(
      new Set([`${PREFIX}/artifact.bin`, `${PREFIX}/globals.bin`, `${PREFIX}/manifest.json`]),
    );
  });

  // The manifest is the object a catalog rebuild turns back into a row. Left behind, it would
  // resurrect an artifact the FAILED job never produced.
  it("deletes all three, the manifest included, when the row cannot be written", async () => {
    const result = await backup({ persist: () => Promise.reject(new Error("insert failed")) });

    expect(result.outcome.ok).toBe(false);
    expect(new Set(result.deleted)).toEqual(
      new Set([`${PREFIX}/artifact.bin`, `${PREFIX}/globals.bin`, `${PREFIX}/manifest.json`]),
    );
    expect(result.reason).toBe("insert failed");
  });

  it("deletes nothing when the backup succeeds", async () => {
    const result = await backup({});

    expect(result.outcome.ok).toBe(true);
    expect(result.put).toEqual([
      `${PREFIX}/artifact.bin`,
      `${PREFIX}/globals.bin`,
      `${PREFIX}/manifest.json`,
    ]);
    expect(result.deleted).toEqual([]);
  });
});
