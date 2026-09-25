// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { SchrodumpError } from "@schrodump/core/errors";
import type { StorageDriver } from "@schrodump/storage/driver";
import { describe, expect, it } from "vitest";
import { classifyVerifyError, createVerifyPorts } from "./verify-wiring.js";

const err = (code: string) => new SchrodumpError("x", { code, correlationId: "c" });

describe("classifyVerifyError", () => {
  it("classifies a source failure as INCONCLUSIVE — our infra, not the artifact", () => {
    expect(classifyVerifyError(err("RESTORE_SOURCE_FAILED"))).toBe("INCONCLUSIVE");
  });

  it("classifies runner failures as INCONCLUSIVE", () => {
    expect(classifyVerifyError(err("RUNNER_SERVICE_NOT_READY"))).toBe("INCONCLUSIVE");
    expect(classifyVerifyError(err("RUNNER_TIMEOUT"))).toBe("INCONCLUSIVE");
    expect(classifyVerifyError(err("RUNNER_NETWORK_MISSING"))).toBe("INCONCLUSIVE");
  });

  it("classifies a shutdown abort as INCONCLUSIVE — an interrupted look observed nothing", () => {
    // Load-bearing, and correct only by RESTORE_ABORTED's absence from RESTORE_FAILED_CODES: adding
    // it there would make every `docker stop` mid-restore condemn an artifact nothing ever read.
    expect(classifyVerifyError(err("RESTORE_ABORTED"))).toBe("INCONCLUSIVE");
  });

  it("classifies a decrypt failure as FAILED — the artifact itself is bad", () => {
    expect(classifyVerifyError(err("RESTORE_DECRYPT_FAILED"))).toBe("FAILED");
  });

  it("classifies an executor failure as FAILED — the restore ran and rejected the dump", () => {
    expect(classifyVerifyError(err("RESTORE_EXECUTOR_FAILED"))).toBe("FAILED");
  });

  it("classifies a scratch write failure as INCONCLUSIVE — our disk failed, not the artifact", () => {
    expect(classifyVerifyError(err("RESTORE_WRITE_FAILED"))).toBe("INCONCLUSIVE");
  });

  it("never FAILs a backup on a surprise — a non-SchrodumpError is INCONCLUSIVE", () => {
    expect(classifyVerifyError(new Error("surprise"))).toBe("INCONCLUSIVE");
  });
});

// The CHECKSUM half of the same law. `checksumMatches` returned a boolean and streamed the object
// inside runVerifyJob's try, so every failure of the DOWNLOAD — a 503, a reset socket, an expired
// credential — became FAILED: a good backup painted red because we could not fetch it, with an
// ARTIFACT_FAILED notification and an invitation to delete it.
describe("compareChecksum tells a verdict from a failure to look", () => {
  const payload = Buffer.from("the stored object");
  const checksum = createHash("sha256").update(payload).digest("hex");

  function ports(get: () => Promise<Readable>, manifestChecksum = checksum) {
    const driver = { get } as unknown as StorageDriver;
    return createVerifyPorts({
      driver,
      bucketKey: "org/job/artifact.bin",
      manifestChecksum,
      runFullRestore: () => Promise.reject(new Error("not used here")),
      setJobState: () => Promise.resolve(),
      setArtifactState: () => Promise.resolve(),
    });
  }

  it("MATCHED when the bytes hash to what the manifest recorded", async () => {
    const result = await ports(() => Promise.resolve(Readable.from([payload]))).compareChecksum();
    expect(result.proof).toBe("MATCHED");
  });

  it("MISMATCHED when they do not", async () => {
    const result = await ports(() =>
      Promise.resolve(Readable.from([Buffer.from("something else")])),
    ).compareChecksum();
    expect(result.proof).toBe("MISMATCHED");
  });

  // Gone IS a verdict: there is no backup at that key.
  it("MISMATCHED when the object is not in the bucket", async () => {
    const missing = new SchrodumpError("s3 get failed: NoSuchKey", {
      code: "STORAGE_GET_FAILED",
      correlationId: "c",
      cause: Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }),
    });
    const result = await ports(() => Promise.reject(missing)).compareChecksum();
    expect(result.proof).toBe("MISMATCHED");
    expect(result.cause).toMatch(/not in the bucket/);
  });

  // Everything else is the bucket, the network or the credential — never the artifact.
  it("INCONCLUSIVE on a transient read failure, and says which one", async () => {
    const transient = new SchrodumpError("s3 get failed: TimeoutError", {
      code: "STORAGE_GET_FAILED",
      correlationId: "c",
      cause: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    });
    const result = await ports(() => Promise.reject(transient)).compareChecksum();
    expect(result.proof).toBe("INCONCLUSIVE");
    expect(result.cause).toMatch(/TimeoutError/);
  });

  it("INCONCLUSIVE when the stream breaks mid-download", async () => {
    const result = await ports(() =>
      Promise.resolve(
        new Readable({
          read() {
            this.destroy(new Error("socket hang up"));
          },
        }),
      ),
    ).compareChecksum();
    expect(result.proof).toBe("INCONCLUSIVE");
  });
});