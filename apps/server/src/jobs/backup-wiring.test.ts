// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Unit test for the one invariant createBackupPorts must never break: a non-zero dump exit has to
// fail the upload so runBackupJob marks the job FAILED and persists NO artifact. No Docker/S3 —
// the Runner and StorageDriver are fakes; only the crypto/stream pipeline is real.

import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import type { PutResult, StorageDriver } from "@schrodump/storage/driver";
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
      opts.stdout?.end();
      return Promise.resolve({ exitCode, stderr: "", durationMs: 1 });
    },
  };
}

// Consumes the ciphertext stream to completion (the hash listener in uploadEncrypted has already put
// it in flowing mode) and resolves — never inspects the bytes.
function fakeDriver(): StorageDriver {
  const unused = (): never => {
    throw new Error("not used in this test");
  };
  return {
    put: (_key: string, body: Readable): Promise<PutResult> =>
      new Promise((resolve, reject) => {
        body.on("error", reject);
        body.on("end", () => resolve({ etag: "e", sizeBytes: 0, checksum: null }));
      }),
    get: unused,
    head: unused,
    delete: unused,
    list: unused,
    canary: unused,
  };
}

async function makeDeps(exitCode: number): Promise<{ deps: BackupWiringDeps; recipient: string }> {
  const recipient = await identityToRecipient(await generateX25519Identity());
  const deps: BackupWiringDeps = {
    jobId: "job-1",
    organizationId: "org-1",
    engine: "postgres",
    runner: fakeRunner(exitCode),
    driver: fakeDriver(),
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
  it("rejects when the dump exits non-zero (no VERIFIED artifact can result)", async () => {
    const { deps, recipient } = await makeDeps(1);
    const ports = createBackupPorts(deps);
    await expect(
      ports.executeAndUpload({
        mode: "STREAM",
        parallelism: 1,
        probe: PROBE,
        recipients: { recipients: [recipient], keyIds: ["k"] },
      }),
    ).rejects.toThrow(/exit code 1/);
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
});
