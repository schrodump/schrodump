// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What the UI sends on every page it serves.
//
// Before this, `next.config.ts` had no `headers()` at all: no CSP, no frame-ancestors, no
// X-Frame-Options, no Referrer-Policy — so the restore dialog and the delete dialog, the two
// controls that destroy data, could be framed and clicked through. The pre-launch audit found it
// (SE-03).
//
// The config itself is the subject: a copy of the header list asserted here would pass while the
// shipped `headers()` said something else.

// @vitest-environment node
//
// The config is a Node module: it resolves `outputFileTracingRoot` from `import.meta.url`, which
// is not a file URL under the DOM environment the component tests run in.

import { describe, expect, it } from "vitest";
import nextConfig, { securityHeaders } from "../../next.config";

async function headerRules() {
  const rules = await nextConfig.headers!();
  expect(rules).toHaveLength(1);
  return rules[0]!;
}

// `source` is a path-to-regexp pattern, and the one this config uses — a negative lookahead over
// the whole path — is passed through to the compiled expression unchanged. Reading it as a regex
// is therefore the same question Next will ask at runtime, and it is asked of real paths rather
// than of the string.
async function matcher() {
  const rule = await headerRules();
  return new RegExp(`^${rule.source}$`);
}

function value(key: string) {
  const header = securityHeaders.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
  return header?.value;
}

function directive(name: string) {
  return (value("Content-Security-Policy") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

describe("the UI's security headers", () => {
  it("applies to every route the app serves itself", async () => {
    const pattern = await matcher();

    // The rule is a catch-all, not an enumeration of today's pages: a screen added next month is
    // covered without anyone remembering to add it to the config.
    for (const path of ["/", "/login", "/artifacts", "/jobs", "/settings", "/setup"]) {
      expect(pattern.test(path)).toBe(true);
    }
  });

  it("leaves the proxied prefixes to the API's own headers", async () => {
    const pattern = await matcher();

    // The API sets its own through @fastify/helmet and the rewrite forwards them. Two
    // X-Frame-Options headers on one response are a duplicate, and a browser discards a
    // duplicated frame-options header instead of enforcing it.
    expect(pattern.test("/backend/artifacts")).toBe(false);
    expect(pattern.test("/api/auth/sign-in/email")).toBe(false);
    // Asserted together with a page the rule MUST still cover: a source that matches nothing at
    // all would otherwise satisfy the two lines above while leaving the whole UI uncovered.
    expect(pattern.test("/artifacts")).toBe(true);
  });

  it("is the list the config actually ships", async () => {
    const rule = await headerRules();

    expect(rule.headers).toBe(securityHeaders);
  });

  it("refuses to be framed, twice over", () => {
    // The restore dialog writes over a live database and the delete dialog destroys a VERIFIED
    // artifact. Both are one click, and a signed-in operator carries the cookie into any frame.
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(value("X-Frame-Options")).toBe("DENY");
  });

  it("tells the browser not to sniff a content type", () => {
    expect(value("X-Content-Type-Options")).toBe("nosniff");
  });

  it("leaks no referrer", () => {
    // Artifact ids and target names live in the path; a Referer carries them to wherever the
    // operator clicks next.
    expect(value("Referrer-Policy")).toBe("no-referrer");
  });

  it("closes the directives a document does not need", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("frame-src")).toBe("frame-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("form-action")).toBe("form-action 'self'");
  });

  it("keeps every fetchable origin to this one", () => {
    // Fonts are vendored (src/fonts), the flags are React components, and the API is reached
    // through the rewrite — so nothing this app loads comes from anywhere else.
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("font-src")).toBe("font-src 'self'");
    expect(directive("img-src")).toBe("img-src 'self' data:");
    expect(directive("script-src")).not.toContain("http");
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
  });

  it("sends no HSTS — that belongs to the reverse proxy", () => {
    // Schrodump serves plain HTTP and the operator terminates TLS in front of it
    // (docs/install.md). A max-age from here pins a host this app cannot serve over TLS.
    expect(value("Strict-Transport-Security")).toBeUndefined();
  });
});
