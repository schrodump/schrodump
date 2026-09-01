// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { parseTrustedProxies } from "./auth.js";

describe("parseTrustedProxies", () => {
  // Unset must mean "trust nothing", never "trust everything". Getting this backwards would make
  // X-Forwarded-For authoritative on a server with no proxy in front of it, and the login rate
  // limit would bucket on a value the attacker writes.
  it("treats unset as trusting nothing", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
  });

  it("splits on commas and trims", () => {
    expect(parseTrustedProxies("127.0.0.1/32, 10.0.0.0/8")).toEqual(["127.0.0.1/32", "10.0.0.0/8"]);
  });

  // An operator who writes SCHRODUMP_TRUSTED_PROXIES= with nothing after it, or leaves a trailing
  // comma, must not end up with an empty-string entry: Better-Auth parses each as a CIDR and an
  // unparseable one is dropped, which would silently shrink the trusted set.
  it("drops empty entries rather than passing them through", () => {
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies("10.0.0.0/8,,")).toEqual(["10.0.0.0/8"]);
    expect(parseTrustedProxies("   ")).toEqual([]);
  });
});
