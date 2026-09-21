// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { loopbackTwinOrigins, parseTrustedProxies } from "./auth.js";

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

describe("loopbackTwinOrigins", () => {
  // The .env.example default is http://localhost:8080 and the README's first command after the
  // stack is up is "open it". An operator who types 127.0.0.1 instead was refused with
  // INVALID_ORIGIN and shown "Invalid email or password" for the password they had just created.
  it("trusts the other loopback spellings on the same scheme and port", () => {
    expect(loopbackTwinOrigins("http://localhost:8080")).toEqual([
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
    ]);
    expect(loopbackTwinOrigins("http://127.0.0.1:18080")).toEqual([
      "http://localhost:18080",
      "http://[::1]:18080",
    ]);
  });

  it("keeps a default port implicit", () => {
    expect(loopbackTwinOrigins("https://localhost")).toEqual(["https://127.0.0.1", "https://[::1]"]);
  });

  // The widening is only safe because both names are the same machine. A real hostname has no
  // twin: a proxy hostname, the server's IP or a typo must still match SCHRODUMP_URL exactly.
  it("adds nothing for a hostname that is not loopback", () => {
    expect(loopbackTwinOrigins("https://backups.example.com")).toEqual([]);
    expect(loopbackTwinOrigins("http://10.0.0.5:8080")).toEqual([]);
  });

  it("adds nothing for a value that is not a URL", () => {
    expect(loopbackTwinOrigins("not a url")).toEqual([]);
  });
});
