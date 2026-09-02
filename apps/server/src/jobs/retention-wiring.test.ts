// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Retention is the only path in this product that DELETES, and the only one whose defects are
// unrecoverable. What it deletes has to be every object a backup wrote — not most of them.

import { describe, expect, it } from "vitest";
import type { StorageDriver } from "@schrodump/storage/driver";
import { createRetentionPorts } from "./retention-wiring.js";

describe("retention deletes everything a backup wrote", () => {
  it("removes the globals object beside the artifact and its manifest", async () => {
    const deleted: string[][] = [];
    const driver = {
      delete: (keys: string[]) => {
        deleted.push(keys);
        return Promise.resolve();
      },
    } as unknown as StorageDriver;

    const ports = createRetentionPorts({
      driver,
      prefix: "p",
      organizationId: "org1",
      artifactJobIds: () => Promise.resolve([]),
      deleteArtifactRow: () => Promise.resolve(),
    });

    await ports.deleteArtifact("job1");

    const keys = deleted[0] ?? [];
    // A postgres backup writes three objects. Deleting two of them left the third permanently:
    // storage outside the configured window, holding pg_dumpall's role password hashes.
    expect(keys.some((k) => k.endsWith("artifact.bin"))).toBe(true);
    expect(keys.some((k) => k.endsWith("manifest.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("globals.bin"))).toBe(true);
  });
});
