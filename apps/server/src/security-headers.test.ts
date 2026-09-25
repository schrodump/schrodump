// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What every API response says about framing, sniffing and referrers.
//
// `@fastify/helmet` was a declared dependency of this app for months and was never registered, so
// the API answered without a single security header — including on `/api/auth/*`, where the
// session cookie is issued. The pre-launch audit found it (SE-03).

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSecurityHeaders } from "./security-headers.js";

// The REAL registration on a bare instance: buildApp needs a PrismaClient, an Auth and a dozen
// stores, none of which decide what this does — and a reimplementation here would test a copy.
async function appWithSecurityHeaders() {
  const app = Fastify();
  registerSecurityHeaders(app);
  app.get("/thing", () => ({ ok: true }));
  app.post("/api/auth/sign-in/email", () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("the API's security headers", () => {
  it("denies framing on an ordinary response", async () => {
    const app = await appWithSecurityHeaders();

    const res = await app.inject({ method: "GET", url: "/thing" });

    expect(res.statusCode).toBe(200);
    // The restore dialog and the delete dialog are one click each. Nothing here is meant to be
    // rendered inside somebody else's page.
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("refuses everything else in the policy — it serves JSON, not a document", async () => {
    const app = await appWithSecurityHeaders();

    const res = await app.inject({ method: "GET", url: "/thing" });

    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("tells the browser not to sniff a content type", async () => {
    const app = await appWithSecurityHeaders();

    const res = await app.inject({ method: "GET", url: "/thing" });

    // An error body echoed back as text/html and sniffed into a document is the other half of
    // the framing problem.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends no referrer — an artifact id is not for wherever the operator clicks next", async () => {
    const app = await appWithSecurityHeaders();

    const res = await app.inject({ method: "GET", url: "/thing" });

    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("covers the Better-Auth routes, where the session cookie is issued", async () => {
    const app = await appWithSecurityHeaders();

    const res = await app.inject({ method: "POST", url: "/api/auth/sign-in/email" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("covers a response that never reached a route", async () => {
    const app = await appWithSecurityHeaders();

    const res = await app.inject({ method: "GET", url: "/nothing-is-mounted-here" });

    // A 404 is a document a browser will happily frame. Registering this as an onRequest hook
    // rather than a route option is what puts it on the 401s and the 404s too.
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("does not send HSTS — that belongs to the reverse proxy", async () => {
    const app = await appWithSecurityHeaders();

    const res = await app.inject({ method: "GET", url: "/thing" });

    // Schrodump listens on plain HTTP by design and the operator terminates TLS in front of it
    // (docs/install.md). A max-age sent from here pins a host this process cannot serve over TLS.
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });
});
