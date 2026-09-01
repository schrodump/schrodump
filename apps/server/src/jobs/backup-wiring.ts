// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real BackupPorts wiring: composes runner (execution) + storage (upload) + the crypto layer and
// the manifest sidecar. Not run in CI (needs Docker + S3 + a target DB); exercised by the gated
// integration tests. Pipeline order is fixed: dump -> compress -> encrypt -> upload.

import { createHash } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import { createGzip } from "node:zlib";
import { resolveCapabilities } from "@schrodump/core/capabilities";
import type { EngineKind } from "@schrodump/core/types";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import { buildArchiveStaging } from "@schrodump/engines/staging";
import type { Manifest } from "@schrodump/core/manifest";
import type { RunMount, Runner } from "@schrodump/runner/runner";
import type { StorageDriver } from "@schrodump/storage/driver";
import { manifestKey, writeManifest } from "@schrodump/storage/manifest-sidecar";
import { encryptStream } from "../crypto/artifact.js";
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
  // The mongo dump reads its password from a `--config` file that must be bind-mounted into the
  // mongodump executor (kept off argv). Set ONLY for the mongodb engine; every other engine passes
  // the password via env (PGPASSWORD/MYSQL_PWD) and runs with no mount. Materialized + cleaned up by
  // the composer (worker-wiring), which holds the decrypted password.
  configMount?: RunMount;
  // Scratch directory a STAGED dump writes its directory-format output into. Mounted into the dump
  // container at the SAME path it was told to write to — a descriptor path that is not mounted is a
  // path inside the container, and the dump dies with it.
  stagingPath?: string;
  // The shutdown signal, bound once at createJobExecutor construction and forwarded into every
  // container-creating run so the runner can force-remove the container on abort. Undefined outside
  // a shutdown (or in tests) — the runner behaves exactly as before.
  readonly signal?: AbortSignal;
  setState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  probe(): Promise<ProbeResult>;
  reserveScratch(estimatedBytes: number): Promise<Reservation>;
  resolveRecipients(): Promise<Recipients>;
  // Descriptors are built by the caller (which holds the decrypted target connection + scope).
  buildDumpDescriptor(
    mode: ExecutionMode,
    parallelism: number,
    probe: ProbeResult,
  ): ExecutionDescriptor;
  buildGlobalsDescriptor(probe: ProbeResult): ExecutionDescriptor | null;
  buildManifest(input: {
    probe: ProbeResult;
    mode: ExecutionMode;
    recipients: Recipients;
    upload: UploadResult;
  }): Manifest;
  persistArtifact(input: {
    probe: ProbeResult;
    mode: ExecutionMode;
    recipients: Recipients;
    upload: UploadResult;
  }): Promise<string>;
}

export function createBackupPorts(deps: BackupWiringDeps): BackupPorts {
  const objectKey = (name: string): string =>
    `${deps.prefix}/${deps.organizationId}/${deps.jobId}/${name}`;

  const uploadEncrypted = async (
    descriptor: ExecutionDescriptor,
    recipients: string[],
    key: string,
    extraMounts: RunMount[] = [],
  ): Promise<{ checksum: string; sizeBytes: number }> => {
    const dumpOut = new PassThrough();
    const runPromise = deps.runner.run(descriptor, {
      network: deps.network,
      // Empty for every engine except mongodb, whose password is delivered through the mounted
      // `--config` file rather than argv/env.
      mounts: [...(deps.configMount !== undefined ? [deps.configMount] : []), ...extraMounts],
      stdout: dumpOut,
      timeoutMs: deps.timeoutMs,
      correlationId: deps.jobId,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    // Attached synchronously, in the same tick runPromise is created — not merely "eventually
    // awaited". encryptStream() below crosses a real threadpool boundary (WebCrypto), so if the run
    // rejects while that's in flight, Node's unhandled-rejection tracker checks once per event-loop
    // turn and would flag runPromise before the Promise.allSettled further down ever gets to attach
    // a handler. This no-op keeps Node from ever seeing it as unhandled; the real outcome is still
    // read from the same promise via Promise.allSettled below.
    runPromise.catch(() => undefined);
    // Count the PLAINTEXT bytes the dump actually produced. A Transform rather than a "data"
    // listener on dumpOut: a listener would switch it to flowing mode before the pipeline below is
    // attached, and bytes written in that window would be dropped. This one only ever sees what
    // really flows through.
    let rawBytes = 0;
    const countRaw = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        rawBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const encrypted = await encryptStream(dumpOut.pipe(countRaw).pipe(createGzip()), recipients);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    encrypted.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });

    // Both settle unconditionally, so neither is ever left an unhandled rejection — a run that
    // fails before streaming (e.g. a missing executor image 404) now ENDS dumpOut (b49c8f7), which
    // lets put() complete instead of hanging; if put() were simply awaited and threw, runPromise
    // would go unobserved and crash the whole worker process, not just this job.
    const [putOutcome, runOutcome] = await Promise.allSettled([
      deps.driver.put(key, encrypted, {
        contentType: "application/octet-stream",
        partSize: PART_SIZE,
        metadata: {},
        // Without this the allSettled below waits for the multipart upload to finish on its own,
        // and the scratch release behind it misses the shutdown grace on a slow link.
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      }),
      runPromise,
    ]);

    // A process that ran without complaint proves nothing: a non-zero exit means the dump did not
    // produce the data. The run's error is the root cause (e.g. that 404) and outranks anything put()
    // or the cleanup below reports. put() above may already have written a (possibly empty) object to
    // `key` even though the run failed — persistArtifact is never called on this path, so no Artifact
    // row will ever exist to let retention reclaim it. Delete it best-effort before throwing so it
    // doesn't outlive the job as a permanent orphan; a delete failure must never mask the run's error.
    if (runOutcome.status === "rejected" || runOutcome.value.exitCode !== 0) {
      await deps.driver.delete([key]).catch(() => undefined);
      if (runOutcome.status === "rejected") throw runOutcome.reason;
      throw new Error(`dump execution failed (exit code ${runOutcome.value.exitCode})`);
    }

    if (putOutcome.status === "rejected") throw putOutcome.reason;

    // A dump tool that exits 0 having written NOTHING did not back anything up, and the object now
    // in the bucket is an empty gzip+age envelope — a few hundred bytes that a CHECKSUM verify
    // would happily confirm against their own manifest, letting an artifact holding no data reach
    // VERIFIED. That is precisely what STAGED did before it was disabled: it wrote a directory
    // while this path read stdout. Deliberately zero bytes, not a size heuristic — no threshold to
    // tune, and no real dump of any engine produces it, since even an empty database emits a
    // header. Delete the orphan first, exactly as the non-zero-exit path does: persistArtifact is
    // never reached, so no row would ever exist for retention to reclaim it by.
    if (rawBytes === 0) {
      await deps.driver.delete([key]).catch(() => undefined);
      throw new Error("dump produced no data (the tool exited 0 but wrote nothing)");
    }

    return { checksum: hash.digest("hex"), sizeBytes };
  };

  // Two runs, one artifact. Both mount the staging directory at the same path the descriptor names.
  const archiveStagedDump = async (
    dumpDescriptor: ExecutionDescriptor,
    recipients: string[],
    key: string,
  ): Promise<{ checksum: string; sizeBytes: number }> => {
    const stagingPath = deps.stagingPath;
    if (stagingPath === undefined) {
      // resolveExecutionMode only chooses STAGED when scratch is configured, so this is a wiring
      // mistake rather than an operator one — fail loudly instead of silently degrading, which is
      // how the empty artifact got out in the first place.
      throw new Error("a STAGED dump requires a staging path, and none was configured");
    }
    // Read-write for the dump: pg_dump -Fd and mydumper create their files here.
    const stagingMount: RunMount = { source: stagingPath, target: stagingPath, readOnly: false };

    const dump = await deps.runner.run(dumpDescriptor, {
      network: deps.network,
      mounts: [...(deps.configMount !== undefined ? [deps.configMount] : []), stagingMount],
      timeoutMs: deps.timeoutMs,
      correlationId: deps.jobId,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    if (dump.exitCode !== 0) {
      throw new Error(`dump execution failed (exit code ${dump.exitCode})`);
    }

    // The archive step reuses the dump's own image — every engine image already ships tar, so this
    // introduces no executor image and no new digest to pin. Read-only: it only reads.
    return await uploadEncrypted(
      buildArchiveStaging({ image: dumpDescriptor.image, stagingPath }),
      recipients,
      key,
      [{ source: stagingPath, target: stagingPath, readOnly: true }],
    );
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
      const dumpDescriptor = deps.buildDumpDescriptor(mode, parallelism, probe);

      // STREAM writes the dump to stdout, so one run produces the artifact. STAGED writes a
      // DIRECTORY, so it takes two: the dump fills a mounted staging directory, then a second run
      // tars that directory to stdout and THAT becomes the artifact. Without the second run the
      // upload reads a stdout the dump never wrote to — an empty artifact under a SUCCEEDED job.
      const { checksum, sizeBytes } =
        mode === "STAGED"
          ? await archiveStagedDump(dumpDescriptor, recipients.recipients, key)
          : await uploadEncrypted(dumpDescriptor, recipients.recipients, key);
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
      writeManifest(
        deps.driver,
        deps.prefix,
        deps.buildManifest({ probe, mode, recipients, upload }),
      ),

    persistArtifact: deps.persistArtifact,
  };
}
