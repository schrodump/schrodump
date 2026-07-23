// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  generateSetupToken,
  setupTokenExpiry,
  type SetupTokenRecord,
} from "../bootstrap/setup-token.js";
import { setupRoutes, type SetupDeps } from "./setup.js";

const NOW = new Date("2026-07-23T12:00:00Z");

async function appWith(deps: SetupDeps) {
  const app = Fastify();
  await app.register((instance) => {
    setupRoutes(deps)(instance);
    return Promise.resolve();
  });
  return app;
}

interface Recorder {
  created: unknown[];
}

function baseDeps(over: Partial<SetupDeps> = {}): SetupDeps & Recorder {
  const rec: Recorder = { created: [] };
  return {
    ...rec,
    userExists: () => Promise.resolve(false),
    findSetupToken: () => Promise.resolve(null),
    consumeAndCreateAdmin: (input) => {
      rec.created.push(input);
      return Promise.resolve();
    },
    now: () => NOW,
    ...over,
  };
}

describe("/setup", () => {
  it("GET returns 404 once a user exists", async () => {
    const app = await appWith(baseDeps({ userExists: () => Promise.resolve(true) }));
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST returns 404 once a user exists", async () => {
    const app = await appWith(baseDeps({ userExists: () => Promise.resolve(true) }));
    const res = await app.inject({
      method: "POST",
      url: "/setup",
      payload: { token: "t", email: "a@b.c", password: "password1" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST with a valid token creates the admin (201)", async () => {
    const { token, tokenHash } = generateSetupToken();
    const record: SetupTokenRecord = { tokenHash, expiresAt: setupTokenExpiry(NOW), consumedAt: null };
    const deps = baseDeps({ findSetupToken: () => Promise.resolve(record) });
    const app = await appWith(deps);
    const res = await app.inject({
      method: "POST",
      url: "/setup",
      payload: { token, email: "admin@example.com", password: "password1" },
    });
    expect(res.statusCode).toBe(201);
    expect(deps.created).toHaveLength(1);
    await app.close();
  });

  it("POST rejects an expired setup token (401)", async () => {
    const { token, tokenHash } = generateSetupToken();
    const record: SetupTokenRecord = {
      tokenHash,
      expiresAt: new Date(NOW.getTime() - 1000),
      consumedAt: null,
    };
    const app = await appWith(baseDeps({ findSetupToken: () => Promise.resolve(record) }));
    const res = await app.inject({
      method: "POST",
      url: "/setup",
      payload: { token, email: "admin@example.com", password: "password1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
