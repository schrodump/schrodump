// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { runSelfBackup, type SelfBackupPorts, type SelfBackupUpload } from "./self-backup.js";

const UPLOAD: SelfBackupUpload = {
  bucketKey: "schrodump/_self/metadata.bin",
  manifestKey: "schrodump/_self/manifest.json",
  sizeBytes: 1024,
  checksum: "abc",
};

function makeHarness(over: Partial<SelfBackupPorts> = {}): {
  ports: SelfBackupPorts;
  states: string[];
  counters: { manifests: number };
} {
  const states: string[] = [];
  const counters = { manifests: 0 };
  const ports: SelfBackupPorts = {
    setState: (state) => {
      states.push(state);
      return Promise.resolve();
    },
    dumpAndUpload: () => Promise.resolve(UPLOAD),
    writeManifest: () => {
      counters.manifests += 1;
      return Promise.resolve();
    },
    ...over,
  };
  return { ports, states, counters };
}

describe("runSelfBackup", () => {
  it("dumps, writes the manifest and succeeds", async () => {
    const h = makeHarness();
    const outcome = await runSelfBackup(h.ports);
    expect(outcome.ok).toBe(true);
    expect(outcome.bucketKey).toBe(UPLOAD.bucketKey);
    expect(h.states).toEqual(["RUNNING", "SUCCEEDED"]);
    expect(h.counters.manifests).toBe(1);
  });

  it("marks FAILED when the dump fails", async () => {
    const h = makeHarness({ dumpAndUpload: () => Promise.reject(new Error("pg_dump failed")) });
    const outcome = await runSelfBackup(h.ports);
    expect(outcome.ok).toBe(false);
    expect(h.states).toContain("FAILED");
  });
});
