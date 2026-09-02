// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What the error handler tells a caller, and what it tells the log.
//
// A malformed JSON body answered 500 with a correlation id and logged "request failed" at error
// level. Fastify had already classified it as a 400 before the handler saw it; flattening every
// non-Zod error into 500 threw that away, told the caller the server had broken, and pointed
// whoever went looking at the wrong side of the connection. Found on the first end-to-end run of
// the shipped deployment, where it cost a round of debugging.

import Fastify from "fastify";
import { ZodError } from "zod";
import { describe, expect, it, vi } from "vitest";
import { registerErrorHandler } from "./errors.js";

// The REAL handler, mounted on a bare instance: buildApp needs a PrismaClient, an Auth and a dozen
// stores, none of which decide what this does — and a reimplementation here would test a copy.
function appWithErrorHandler() {
  const app = Fastify();
  registerErrorHandler(app);
  app.post("/thing", () => ({ ok: true }));
  return app;
}

describe("the error handler", () => {
  it("answers 400 for a body Fastify could not parse, not 500", async () => {
    const app = appWithErrorHandler();

    const res = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { "content-type": "application/json" },
      payload: "",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid request" });
  });

  it("does not put the unparseable payload in the response", async () => {
    const app = appWithErrorHandler();

    const res = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { "content-type": "application/json" },
      payload: '{"password":"hunter2-but-longer",',
    });

    expect(res.statusCode).toBe(400);
    // Fastify's own message for a bad body can quote it, and request bodies here carry database
    // passwords and S3 secret keys. The response stays generic on both sides of the 400/500 line.
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("password");
  });

  it("logs a client error at warn, not at error", async () => {
    const app = appWithErrorHandler();
    const warn = vi.fn();
    const error = vi.fn();
    app.addHook("onRequest", (request, _reply, done) => {
      request.log.warn = warn as unknown as typeof request.log.warn;
      request.log.error = error as unknown as typeof request.log.error;
      done();
    });

    await app.inject({
      method: "POST",
      url: "/thing",
      headers: { "content-type": "application/json" },
      payload: "",
    });

    // A log that records client mistakes at error level fills with entries that look like
    // outages and are not — which is how a real one gets missed.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("still answers 500 with the correlation id for a genuine server fault", async () => {
    const app = appWithErrorHandler();
    app.post("/boom", () => {
      throw new Error("something actually broke");
    });

    const res = await app.inject({ method: "POST", url: "/boom" });

    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string; correlationId: string };
    expect(body.error).toBe("internal error");
    // The correlation id is what joins this response to the log line that has the stack.
    expect(body.correlationId).toBeTruthy();
    expect(res.body).not.toContain("something actually broke");
  });

  it("keeps a Zod failure at 400", async () => {
    const app = appWithErrorHandler();
    app.post("/zod", () => {
      throw new ZodError([]);
    });

    const res = await app.inject({ method: "POST", url: "/zod" });

    expect(res.statusCode).toBe(400);
  });
});
