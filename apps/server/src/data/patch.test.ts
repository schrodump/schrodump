// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { definedOnly } from "./patch.js";

describe("definedOnly", () => {
  it("drops keys explicitly set to undefined and keeps the rest", () => {
    expect(definedOnly({ a: 1, b: undefined, c: "x" })).toEqual({ a: 1, c: "x" });
    expect("b" in definedOnly({ a: 1, b: undefined })).toBe(false);
  });

  // A PATCH says "change these fields". null and false and 0 are values someone asked for;
  // only absence means "leave it alone". Treating a falsy value as absent would silently ignore
  // `enabled: false` — the one edit with no other way to express it.
  it("keeps falsy values, which are edits like any other", () => {
    expect(definedOnly({ enabled: false, keepLast: 0, endpoint: null })).toEqual({
      enabled: false,
      keepLast: 0,
      endpoint: null,
    });
  });

  it("returns an empty object when every key is undefined", () => {
    expect(definedOnly({ a: undefined, b: undefined })).toEqual({});
  });
});
