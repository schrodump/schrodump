// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { resolveVerifyPlan } from "./worker-wiring.js";

describe("resolveVerifyPlan", () => {
  it("downgrades FULL_RESTORE to CHECKSUM and records the reason", () => {
    expect(resolveVerifyPlan("FULL_RESTORE")).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: "restore executor unavailable: FULL_RESTORE downgraded to CHECKSUM",
    });
  });

  it("keeps CHECKSUM unchanged with no downgrade reason", () => {
    expect(resolveVerifyPlan("CHECKSUM")).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: null,
    });
  });

  it("keeps NONE unchanged with no downgrade reason", () => {
    expect(resolveVerifyPlan("NONE")).toEqual({
      effectiveLevel: "NONE",
      downgradeReason: null,
    });
  });

  it("defaults a missing policy level to CHECKSUM without a downgrade", () => {
    expect(resolveVerifyPlan(null)).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: null,
    });
  });
});
