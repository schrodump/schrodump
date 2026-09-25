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
      newestVerifiedJobId: () => Promise.resolve(null),
      recordedKeys: () => Promise.resolve(null),
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

  // The defect this reclaims: with the destination form's default prefix of "", the write path's
  // template literal produced `/org1/job1/artifact.bin` while everything that reads or deletes
  // computed `org1/job1/artifact.bin`. The manifest matched (it always used the shared builder), so
  // retention deleted the manifest and the row, reported success, and left the artifact behind —
  // observed on a real instance as `bucketKey = "/cmtq…"` beside `manifestKey = "cmtq…"` in one row.
  //
  // The shared builder stops new ones. Only the row knows where the OLD ones went, so the row is
  // asked and both spellings are deleted.
  it("also deletes the key the artifact was actually written under, whatever it was", async () => {
    const deleted: string[][] = [];
    const driver = {
      delete: (keys: string[]) => {
        deleted.push(keys);
        return Promise.resolve();
      },
    } as unknown as StorageDriver;

    const ports = createRetentionPorts({
      driver,
      prefix: "",
      organizationId: "org1",
      artifactJobIds: () => Promise.resolve([]),
      newestVerifiedJobId: () => Promise.resolve(null),
      recordedKeys: () =>
        Promise.resolve({
          bucketKey: "/org1/job1/artifact.bin",
          manifestKey: "org1/job1/manifest.json",
        }),
      deleteArtifactRow: () => Promise.resolve(),
    });

    await ports.deleteArtifact("job1");

    const keys = deleted[0] ?? [];
    expect(keys).toContain("/org1/job1/artifact.bin");
    // Its globals sidecar sits beside it, under the same spelling.
    expect(keys).toContain("/org1/job1/globals.bin");
    // And the computed spelling is still named, for every artifact written since the fix.
    expect(keys).toContain("org1/job1/artifact.bin");
    expect(keys).toContain("org1/job1/manifest.json");
  });
});
