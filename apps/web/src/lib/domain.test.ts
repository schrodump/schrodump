// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { canRestore, canRestoreArtifact, ENGINE_KINDS, RESTORE_TARGETS_BY_ENGINE } from "./domain";

describe("canRestore", () => {
  it("allows operator and admin but never viewer", () => {
    expect(canRestore("admin")).toBe(true);
    expect(canRestore("operator")).toBe(true);
    expect(canRestore("viewer")).toBe(false);
  });
});

describe("canRestoreArtifact", () => {
  it("allows a STREAM artifact of every engine — restore works end-to-end for all four", () => {
    for (const engine of ENGINE_KINDS) {
      expect(canRestoreArtifact({ engine, executionMode: "STREAM" })).toBe(true);
    }
  });

  // The gate is execution-mode-based, not engine-based: a STAGED artifact needs a directory
  // pipeline (untar-to-directory, myloader / pg_restore -Fd) that v1 does not have, so the server
  // refuses it regardless of engine — postgres -Fd included. Offering the button anyway enqueues a
  // job that is certain to fail.
  it("allows a STAGED artifact of every engine, mirroring the server's directory pipeline", () => {
    // The gate lifted on the server once a STAGED dump could be archived on the way out and
    // unpacked on the way back. Leaving the button hidden here would hide a restore that works.
    for (const engine of ENGINE_KINDS) {
      expect(canRestoreArtifact({ engine, executionMode: "STAGED" })).toBe(true);
    }
  });
});

describe("RESTORE_TARGETS_BY_ENGINE", () => {
  it("mirrors the capability matrix: postgres has SCHEMA, mongodb has neither", () => {
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).toContain("SCHEMA");
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).not.toContain("COLLECTION");
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).not.toContain("SCHEMA");
  });

  it("offers mongodb no sub-scope target, matching the server's refusal", () => {
    // Not a UI preference. mongorestore runs with --drop and no --nsInclude, so a scoped restore
    // would drop and overwrite every namespace in the archive; the server withdrew those targets
    // and refuses them. Offering one here would put a button in front of a guaranteed rejection —
    // and the server is the lock, so a drift in this direction is a UX bug, not a safety one.
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).toEqual(["FULL_CLUSTER"]);
  });
});
