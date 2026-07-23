// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { injectOrgScope } from "./scope.js";

describe("injectOrgScope", () => {
  it("adds organizationId to where for read operations on scoped models", () => {
    const out = injectOrgScope("DatabaseTarget", "findMany", { where: { engine: "postgres" } }, "org-1");
    expect(out.where).toEqual({ engine: "postgres", organizationId: "org-1" });
  });

  it("scopes findUnique lookups by organizationId as well", () => {
    const out = injectOrgScope("Artifact", "findUnique", { where: { id: "x" } }, "org-1");
    expect(out.where).toEqual({ id: "x", organizationId: "org-1" });
  });

  it("adds organizationId to data on create", () => {
    const out = injectOrgScope("DatabaseTarget", "create", { data: { name: "t" } }, "org-1");
    expect(out.data).toEqual({ name: "t", organizationId: "org-1" });
  });

  it("adds organizationId to every row of createMany", () => {
    const out = injectOrgScope(
      "AuditLog",
      "createMany",
      { data: [{ action: "a" }, { action: "b" }] },
      "org-9",
    );
    expect(out.data).toEqual([
      { action: "a", organizationId: "org-9" },
      { action: "b", organizationId: "org-9" },
    ]);
  });

  it("scopes both branches of upsert", () => {
    const out = injectOrgScope(
      "EncryptionKey",
      "upsert",
      { where: { id: "k" }, create: { keyId: "fp" }, update: {} },
      "org-2",
    );
    expect(out.where).toEqual({ id: "k", organizationId: "org-2" });
    expect(out.create).toEqual({ keyId: "fp", organizationId: "org-2" });
  });

  it("leaves non-scoped models (User, AppConfig) untouched", () => {
    const args = { where: { email: "a@b.c" } };
    expect(injectOrgScope("User", "findUnique", args, "org-1")).toBe(args);
    expect(injectOrgScope("AppConfig", "findMany", { where: {} }, "org-1")).toEqual({ where: {} });
  });
});
