// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real VerifyPorts wiring. Not run in CI (needs S3 + Docker). CHECKSUM re-downloads the stored
// object and recomputes the hash; FULL_RESTORE is delegated to a caller-composed ephemeral
// container that MUST run on an isolated network with no access to production target networks.

import { createHash } from "node:crypto";
import { SchrodumpError } from "@schrodump/core/errors";
import type { StorageDriver } from "@schrodump/storage/driver";
import type { VerifyPorts, VerifyProof } from "./verify.js";

export interface VerifyWiringDeps {
  driver: StorageDriver;
  bucketKey: string;
  // Checksum of the stored (encrypted) object, from the manifest.
  manifestChecksum: string;
  // Restores the artifact into an ephemeral, isolated-network container of the correct major, runs
  // the minimal assertions (row/collection counts vs. dump time, constraint presence, migration
  // version), then destroys the container. Three-way: VERIFIED/FAILED are claims about the
  // artifact; INCONCLUSIVE means the sandbox itself failed to run the attempt.
  runFullRestore(): Promise<VerifyProof>;
  setJobState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  setArtifactState(state: "VERIFIED" | "FAILED"): Promise<void>;
}

// Restore-executor codes that mean the restore actually ran against the dump and rejected it —
// the artifact is the problem. Every other SchrodumpError code (RESTORE_SOURCE_FAILED, RUNNER_*)
// and every non-SchrodumpError is our own infra failing to even attempt the restore: INCONCLUSIVE,
// never FAILED — we must not condemn a backup because our sandbox couldn't run.
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
    checksumMatches: async () => {
      const stream = await deps.driver.get(deps.bucketKey);
      const hash = createHash("sha256");
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
      return hash.digest("hex") === deps.manifestChecksum;
    },
    fullRestore: () => deps.runFullRestore(),
  };
}
