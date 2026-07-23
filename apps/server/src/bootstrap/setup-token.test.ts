// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  generateSetupToken,
  hashSetupToken,
  isSetupTokenUsable,
  setupTokenExpiry,
} from "./setup-token.js";

const NOW = new Date("2026-07-23T12:00:00Z");

describe("setup token", () => {
  it("generates a token whose stored hash matches, and never equals the raw token", () => {
    const { token, tokenHash } = generateSetupToken();
    expect(hashSetupToken(token)).toBe(tokenHash);
    expect(token).not.toBe(tokenHash);
  });

  it("accepts a fresh, unconsumed token", () => {
    const record = { tokenHash: "h", expiresAt: setupTokenExpiry(NOW), consumedAt: null };
    expect(isSetupTokenUsable(record, NOW)).toBe(true);
  });

  it("rejects an expired token", () => {
    const record = { tokenHash: "h", expiresAt: new Date(NOW.getTime() - 1000), consumedAt: null };
    expect(isSetupTokenUsable(record, NOW)).toBe(false);
  });

  it("rejects a consumed token", () => {
    const record = { tokenHash: "h", expiresAt: setupTokenExpiry(NOW), consumedAt: NOW };
    expect(isSetupTokenUsable(record, NOW)).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(isSetupTokenUsable(null, NOW)).toBe(false);
  });
});
