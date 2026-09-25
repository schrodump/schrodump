// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real VerifyPorts wiring. Not run in CI (needs S3 + Docker). CHECKSUM re-downloads the stored
// object and recomputes the hash; FULL_RESTORE is delegated to a caller-composed ephemeral
// container that the wiring places on SCHRODUMP_EXECUTOR_NETWORK — the SAME shared executor network
// the dump/restore executors use to reach real targets, not a per-verify isolated network. That is
// acceptable because the sandbox is a passive, throwaway RECEIVER: it restores the org's OWN artifact
// into a fresh container that lives seconds and is destroyed after, never reaching out to a target.

import { createHash } from "node:crypto";
import { SchrodumpError } from "@schrodump/core/errors";
import type { StorageDriver } from "@schrodump/storage/driver";
import { isObjectMissing } from "@schrodump/storage/s3";
import type { ChecksumResult, FullRestoreResult, VerifyPorts, VerifyProof } from "./verify.js";

export interface VerifyWiringDeps {
  driver: StorageDriver;
  bucketKey: string;
  // Checksum of the stored (encrypted) object, from the manifest.
  manifestChecksum: string;
  // Restores the artifact into an ephemeral container of the correct major on the shared executor
  // network (a throwaway receiver of the org's own artifact, destroyed after), runs the minimal
  // assertions (row/collection counts vs. dump time, constraint presence, migration version), then
  // destroys the container. Three-way: VERIFIED/FAILED are claims about the artifact; INCONCLUSIVE
  // means the sandbox itself failed to run the attempt.
  runFullRestore(): Promise<FullRestoreResult>;
  setJobState(
    state: "RUNNING" | "SUCCEEDED" | "FAILED" | "INCONCLUSIVE",
    reason?: string,
  ): Promise<void>;
  setArtifactState(state: "VERIFIED" | "FAILED"): Promise<void>;
}

// Restore-executor codes that mean the restore actually ran against the dump and rejected it —
// the artifact is the problem. Every other SchrodumpError code (RESTORE_SOURCE_FAILED,
// RESTORE_WRITE_FAILED — our scratch disk, not the dump —, RUNNER_*) and every non-SchrodumpError
// is our own infra failing to even attempt the restore: INCONCLUSIVE, never FAILED — we must not
// condemn a backup because our sandbox couldn't run.
const RESTORE_FAILED_CODES = new Set(["RESTORE_DECRYPT_FAILED", "RESTORE_EXECUTOR_FAILED"]);

export function classifyVerifyError(err: unknown): VerifyProof {
  if (err instanceof SchrodumpError && RESTORE_FAILED_CODES.has(err.code)) {
    return "FAILED";
  }
  return "INCONCLUSIVE";
}

export function createVerifyPorts(deps: VerifyWiringDeps): VerifyPorts {
  return {
    setJobState: deps.setJobState,
    setArtifactState: deps.setArtifactState,
    compareChecksum: async (): Promise<ChecksumResult> => {
      let digest: string;
      try {
        const stream = await deps.driver.get(deps.bucketKey);
        const hash = createHash("sha256");
        for await (const chunk of stream) {
          hash.update(chunk as Buffer);
        }
        digest = hash.digest("hex");
      } catch (err) {
        // The object being GONE is a verdict — there is no backup at that key, and saying so is
        // the honest answer. Every other failure is the bucket, the network or the credential, and
        // condemning a backup because we could not fetch it is the one thing this product must
        // never do. The driver wraps its errors, so the AWS name is one `cause` down.
        if (isObjectMissing(err)) {
          return { proof: "MISMATCHED", cause: "the stored object is not in the bucket" };
        }
        // SchrodumpError's message is already redacted ("s3 get failed: TimeoutError"); it names
        // the operation and the AWS error class and carries no credential.
        return {
          proof: "INCONCLUSIVE",
          cause: err instanceof Error ? err.message : "the stored object could not be read",
        };
      }
      return digest === deps.manifestChecksum
        ? { proof: "MATCHED", cause: null }
        : { proof: "MISMATCHED", cause: null };
    },
    fullRestore: () => deps.runFullRestore(),
  };
}
