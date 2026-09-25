// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loopbackTwinOrigins, parseTrustedProxies, registerAuthHandler, type Auth } from "./auth.js";

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

describe("registerAuthHandler", () => {
  // Every account in this product is created by the bootstrap or by an admin through POST /members.
  // Better-Auth's own sign-up endpoint had no legitimate caller and two consequences: an address
  // registered by a stranger is taken forever (POST /members then answers 409), and a sign-up before
  // the first admin used to close /setup permanently. It is blocked here rather than with
  // Better-Auth's `disableSignUp`, which refuses inside the handler and would also refuse
  // auth.api.signUpEmail — the call the bootstrap and POST /members make.
  async function appWithHandler(): Promise<{ app: ReturnType<typeof Fastify>; seen: string[] }> {
    const seen: string[] = [];
    const auth = {
      handler: (request: Request) => {
        seen.push(new URL(request.url).pathname);
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      },
    } as unknown as Auth;
    const app = Fastify();
    registerAuthHandler(app, auth);
    await app.ready();
    return { app, seen };
  }

  it("answers 404 for the public sign-up endpoint, and never reaches Better-Auth", async () => {
    const { app, seen } = await appWithHandler();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "stranger@example.com", password: "a-long-enough-password" },
    });
    expect(res.statusCode).toBe(404);
    expect(seen).toEqual([]);
    await app.close();
  });

  it("still forwards the endpoints the product uses", async () => {
    const { app, seen } = await appWithHandler();
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@example.com", password: "a-long-enough-password" },
    });
    const session = await app.inject({ method: "GET", url: "/api/auth/get-session" });
    expect(signIn.statusCode).toBe(200);
    expect(session.statusCode).toBe(200);
    expect(seen).toEqual(["/api/auth/sign-in/email", "/api/auth/get-session"]);
    await app.close();
  });
});
