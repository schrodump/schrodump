// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  isSelfBackupDue,
  runSelfBackup,
  selectSelfBackupRecipients,
  type SelfBackupPorts,
  type SelfBackupUpload,
} from "./self-backup.js";

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

describe("selectSelfBackupRecipients", () => {
  const escrow = {
    keyId: "esc",
    type: "escrow",
    publicRecipient: "age1escrow",
    state: "active",
  } as const;
  const operational = {
    keyId: "ops",
    type: "operational",
    publicRecipient: "age1ops",
    state: "active",
  } as const;

  it("refuses to seal a self-backup when no escrow key is active", () => {
    // The failure mode this guards: an artifact encrypted only to the operational key, whose
    // identity lives inside the very database being dumped. It would upload, report SUCCEEDED, and
    // be unopenable in the only situation it exists for.
    expect(() => selectSelfBackupRecipients([operational])).toThrow(/escrow/);
    expect(() => selectSelfBackupRecipients([{ ...escrow, state: "retired" }, operational])).toThrow(
      /escrow/,
    );
  });

  it("puts escrow first and keeps operational as a convenience", () => {
    const chosen = selectSelfBackupRecipients([operational, escrow]);
    expect(chosen.recipients).toEqual(["age1escrow", "age1ops"]);
    expect(chosen.keyIds).toEqual(["esc", "ops"]);
  });

  it("seals to escrow alone when there is no operational key", () => {
    expect(selectSelfBackupRecipients([escrow]).recipients).toEqual(["age1escrow"]);
  });
});

describe("isSelfBackupDue", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const DAY = 86_400_000;

  it("is due when nothing has ever succeeded", () => {
    expect(isSelfBackupDue(null, now, DAY)).toBe(true);
  });

  it("is not due inside the interval", () => {
    expect(isSelfBackupDue(new Date("2026-09-01T11:59:00Z"), now, DAY)).toBe(false);
  });

  // The restart trap: a process-local timer would never fire on a server redeployed hourly.
  // Keying on the last SUCCEEDED run makes the elapsed time survive the restart.
  it("is due once the interval has elapsed, regardless of restarts", () => {
    expect(isSelfBackupDue(new Date("2026-08-31T11:59:00Z"), now, DAY)).toBe(true);
  });

  it("is due exactly at the boundary", () => {
    expect(isSelfBackupDue(new Date("2026-08-31T12:00:00Z"), now, DAY)).toBe(true);
  });
});
