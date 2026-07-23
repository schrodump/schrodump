// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real VerifyPorts wiring. Not run in CI (needs S3 + Docker). CHECKSUM re-downloads the stored
// object and recomputes the hash; FULL_RESTORE is delegated to a caller-composed ephemeral
// container that MUST run on an isolated network with no access to production target networks.

import { createHash } from "node:crypto";
import type { StorageDriver } from "@schrodump/storage/driver";
import type { VerifyPorts } from "./verify.js";

export interface VerifyWiringDeps {
  driver: StorageDriver;
  bucketKey: string;
  // Checksum of the stored (encrypted) object, from the manifest.
  manifestChecksum: string;
  // Restores the artifact into an ephemeral container on an ISOLATED network and runs the minimal
  // assertions (row/collection counts vs. dump time, constraint presence, migration version), then
  // destroys the container. Returns whether every assertion passed.
  runFullRestore(): Promise<boolean>;
  setJobState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  setArtifactState(state: "VERIFIED" | "FAILED"): Promise<void>;
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
