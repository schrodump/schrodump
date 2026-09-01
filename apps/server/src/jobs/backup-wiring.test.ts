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
import type { ProbeResult } from "./backup.js";

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
function fakeRunner(exitCode: number): Runner {
  return {
    run: (_descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> => {
      // Writes real bytes before ending. It used to only end the stream, which modelled a dump that
      // produced NOTHING as a success — the very shape that shipped an empty artifact under a
      // SUCCEEDED job. A fixture that cannot tell those apart cannot catch them.
      opts.stdout?.write(Buffer.from("-- pg_dump fixture payload\n"));
      opts.stdout?.end();
      return Promise.resolve({ exitCode, stderr: "", durationMs: 1 });
    },
    // Backup never provisions an ephemeral service; satisfy the interface without exercising it.
    withEphemeralService: () => Promise.reject(new Error("not used in backup tests")),
  };
}

// Consumes the ciphertext stream to completion (the hash listener in uploadEncrypted has already put
// it in flowing mode) and resolves — never inspects the bytes. `deletedKeys` records what the
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
