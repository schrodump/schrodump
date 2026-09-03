// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { canRestore, ENGINE_KINDS, RESTORE_TARGETS_BY_ENGINE } from "./domain";

describe("canRestore", () => {
  it("allows operator and admin but never viewer", () => {
    expect(canRestore("admin")).toBe(true);
    expect(canRestore("operator")).toBe(true);
    expect(canRestore("viewer")).toBe(false);
  });
});

describe("RESTORE_TARGETS_BY_ENGINE", () => {
  it("covers every engine, so a new one cannot render an undefined target list", () => {
    // Replaces a test that looped the engines through a predicate which could not fail. This one
    // can: adding an engine to ENGINE_KINDS without a row here makes `supported` undefined in the
    // restore dialog, and `supported.includes` throws on the first render.
    for (const engine of ENGINE_KINDS) {
      expect(RESTORE_TARGETS_BY_ENGINE[engine]).toBeDefined();
      expect(RESTORE_TARGETS_BY_ENGINE[engine]).toContain("FULL_CLUSTER");
    }
  });

  it("mirrors the capability matrix: postgres has SCHEMA, mongodb has neither", () => {
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).toContain("SCHEMA");
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).not.toContain("COLLECTION");
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).not.toContain("SCHEMA");
  });

  it("mirrors the server's mongodb targets exactly, in mongo's own vocabulary", () => {
    // Not a UI preference — a mirror. The server's capability matrix is the lock, and this list
    // decides what the restore dialog offers; drift in either direction is a bug, but only drift
    // that offers MORE than the server accepts puts a button in front of a guaranteed rejection.
    // Sub-scope returned once buildRestore emitted --nsInclude, which is what scopes --drop.
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).toEqual(["FULL_CLUSTER", "DATABASE", "COLLECTION"]);
  });
});
