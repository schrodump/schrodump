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
  it("refuses a STAGED artifact of every engine, mirroring the server's gate", () => {
    for (const engine of ENGINE_KINDS) {
      expect(canRestoreArtifact({ engine, executionMode: "STAGED" })).toBe(false);
    }
  });
});

describe("RESTORE_TARGETS_BY_ENGINE", () => {
  it("mirrors the capability matrix (postgres has SCHEMA, mongodb has COLLECTION)", () => {
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).toContain("SCHEMA");
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).not.toContain("COLLECTION");
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).toContain("COLLECTION");
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).not.toContain("SCHEMA");
  });
});
