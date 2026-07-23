// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real RestorePorts wiring. Not run in CI. The supported restore targets come from the capability
// matrix; runRestore is delegated to a caller-composed download -> decrypt -> restore container.

import { resolveCapabilities } from "@schrodump/core/capabilities";
import type { EngineKind } from "@schrodump/core/types";
import type { EncryptionKeyRecord } from "../crypto/artifact.js";
import type { ArtifactForRestore, RestorePorts } from "./restore.js";

export interface RestoreWiringDeps {
  loadArtifactRow(): Promise<{
    manifestKeyIds: string[];
    engine: EngineKind;
    serverVersionNum: number;
    destinationName: string;
  }>;
  availableKeys(): Promise<EncryptionKeyRecord[]>;
  targetHasExistingData(): Promise<boolean>;
  audit(event: {
    action: string;
    artifactId: string;
    userId: string;
    destinationName: string;
    keyId: string;
  }): Promise<void>;
  setJobState(state: "RUNNING" | "SUCCEEDED" | "FAILED", reason?: string): Promise<void>;
  runRestore(keyId: string): Promise<boolean>;
}

export function createRestorePorts(deps: RestoreWiringDeps): RestorePorts {
  return {
    loadArtifact: async (): Promise<ArtifactForRestore> => {
      const row = await deps.loadArtifactRow();
      const caps = resolveCapabilities(row.engine, row.serverVersionNum);
      return {
        manifestKeyIds: row.manifestKeyIds,
        engine: row.engine,
        supportedRestoreTargets: [...caps.supportedRestoreTargets],
        destinationName: row.destinationName,
      };
    },
    availableKeys: deps.availableKeys,
    targetHasExistingData: deps.targetHasExistingData,
    audit: deps.audit,
    setJobState: deps.setJobState,
    runRestore: deps.runRestore,
  };
}
