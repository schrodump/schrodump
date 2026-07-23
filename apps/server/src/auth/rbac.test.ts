// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { canTriggerRestore, hasAtLeast, type Role } from "./rbac.js";

describe("role hierarchy", () => {
  it("ranks admin >= operator >= viewer", () => {
    expect(hasAtLeast("admin", "operator")).toBe(true);
    expect(hasAtLeast("operator", "operator")).toBe(true);
    expect(hasAtLeast("viewer", "operator")).toBe(false);
    expect(hasAtLeast("operator", "admin")).toBe(false);
  });

  it("lets operator and admin trigger restore but never viewer", () => {
    const allowed: Role[] = ["admin", "operator"];
    for (const role of allowed) expect(canTriggerRestore(role)).toBe(true);
    expect(canTriggerRestore("viewer")).toBe(false);
  });
});
