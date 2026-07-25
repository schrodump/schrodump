// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { canRestore, canRestoreEngine, ENGINE_KINDS, RESTORE_TARGETS_BY_ENGINE } from "./domain";

describe("canRestore", () => {
  it("allows operator and admin but never viewer", () => {
    expect(canRestore("admin")).toBe(true);
    expect(canRestore("operator")).toBe(true);
    expect(canRestore("viewer")).toBe(false);
  });
});

describe("canRestoreEngine", () => {
  it("allows all four engines — STREAM restore+verify works everywhere; the server enforces STREAM-only", () => {
    for (const engine of ENGINE_KINDS) {
      expect(canRestoreEngine(engine)).toBe(true);
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
