// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real BackupPorts wiring: composes runner (execution) + storage (upload) + the crypto layer and
// the manifest sidecar. Not run in CI (needs Docker + S3 + a target DB); exercised by the gated
// integration tests. Pipeline order is fixed: dump -> compress -> encrypt -> upload.

import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { Encrypter } from "age-encryption";
import { resolveCapabilities } from "@schrodump/core/capabilities";
import type { EngineKind } from "@schrodump/core/types";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import type { Manifest } from "@schrodump/core/manifest";
import type { Runner } from "@schrodump/runner/runner";
import type { StorageDriver } from "@schrodump/storage/driver";
import { manifestKey, writeManifest } from "@schrodump/storage/manifest-sidecar";
import type { ExecutionMode } from "./execution-mode.js";
import type { BackupPorts, ProbeResult, Recipients, Reservation, UploadResult } from "./backup.js";

const PART_SIZE = 64 * 1024 * 1024;

export interface BackupWiringDeps {
  jobId: string;
  organizationId: string;
  engine: EngineKind;
  runner: Runner;
  driver: StorageDriver;
  // Isolated network for the executor; never inherited.
  network: string;
  prefix: string;
  timeoutMs: number;
  setState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  probe(): Promise<ProbeResult>;
  reserveScratch(estimatedBytes: number): Promise<Reservation>;
  resolveRecipients(): Promise<Recipients>;
  // Descriptors are built by the caller (which holds the decrypted target connection + scope).
  buildDumpDescriptor(mode: ExecutionMode, parallelism: number, probe: ProbeResult): ExecutionDescriptor;
  buildGlobalsDescriptor(probe: ProbeResult): ExecutionDescriptor | null;
  buildManifest(input: { probe: ProbeResult; mode: ExecutionMode; recipients: Recipients; upload: UploadResult }): Manifest;
  persistArtifact(input: { probe: ProbeResult; mode: ExecutionMode; recipients: Recipients; upload: UploadResult }): Promise<string>;
}

// Encrypts a compressed Node stream for the recipients using age's STREAM construction (chunked,
// per-chunk authenticated, truncation-detecting), returning a Node Readable of the ciphertext.
async function encryptStream(compressed: Readable, recipients: string[]): Promise<Readable> {
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  const source = Readable.toWeb(compressed) as ReadableStream<Uint8Array>;
  return Readable.fromWeb(await encrypter.encrypt(source));
}

export function createBackupPorts(deps: BackupWiringDeps): BackupPorts {
  const objectKey = (name: string): string =>
    `${deps.prefix}/${deps.organizationId}/${deps.jobId}/${name}`;

  const uploadEncrypted = async (
    descriptor: ExecutionDescriptor,
    recipients: string[],
    key: string,
  ): Promise<{ checksum: string; sizeBytes: number }> => {
    const dumpOut = new PassThrough();
    const runPromise = deps.runner.run(descriptor, {
      network: deps.network,
      mounts: [],
      stdout: dumpOut,
      timeoutMs: deps.timeoutMs,
      correlationId: deps.jobId,
    });
    const encrypted = await encryptStream(dumpOut.pipe(createGzip()), recipients);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    encrypted.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });
    await deps.driver.put(key, encrypted, {
      contentType: "application/octet-stream",
      partSize: PART_SIZE,
      metadata: {},
    });
    await runPromise;
    return { checksum: hash.digest("hex"), sizeBytes };
  };

  return {
    setState: deps.setState,
    probe: deps.probe,
    capabilities: (serverVersionNum) => {
      const caps = resolveCapabilities(deps.engine, serverVersionNum);
      return {
        stagedCapable: caps.stagedCapable,
        requiresSeparateGlobalsDump: caps.requiresSeparateGlobalsDump,
      };
    },
    reserveScratch: deps.reserveScratch,
    resolveRecipients: deps.resolveRecipients,

    executeAndUpload: async ({ mode, parallelism, probe, recipients }) => {
      const key = objectKey("artifact.bin");
      const { checksum, sizeBytes } = await uploadEncrypted(
        deps.buildDumpDescriptor(mode, parallelism, probe),
        recipients.recipients,
        key,
      );
      return {
        bucketKey: key,
        manifestKey: manifestKey(deps.prefix, deps.organizationId, deps.jobId),
        sizeRawBytes: probe.estimatedBytes,
        sizeCompressedBytes: sizeBytes,
        checksumAlgorithm: "sha256",
        checksum,
      };
    },

    executeGlobals: async ({ recipients, probe }) => {
      const globals = deps.buildGlobalsDescriptor(probe);
      if (globals === null) return;
      await uploadEncrypted(globals, recipients.recipients, objectKey("globals.bin"));
    },

    writeManifest: ({ probe, mode, recipients, upload }) =>
      writeManifest(deps.driver, deps.prefix, deps.buildManifest({ probe, mode, recipients, upload })),

    persistArtifact: deps.persistArtifact,
  };
}
