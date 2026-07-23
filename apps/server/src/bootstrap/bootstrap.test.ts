// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { bootstrap, type BootstrapDeps } from "./bootstrap.js";

const NOW = new Date("2026-07-23T12:00:00Z");

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://x",
    SCHRODUMP_KEK: "kek",
    SCHRODUMP_URL: "http://localhost:8080",
    PORT: 8080,
    LOG_LEVEL: "info",
    ...over,
  };
}

interface Recorder {
  admins: unknown[];
  tokens: unknown[];
  logs: unknown[];
}

function makeDeps(over: Partial<BootstrapDeps> = {}): BootstrapDeps & Recorder {
  const rec: Recorder = { admins: [], tokens: [], logs: [] };
  return {
    ...rec,
    userCount: () => Promise.resolve(0),
    createAdmin: (input) => {
      rec.admins.push(input);
      return Promise.resolve();
    },
    createSetupToken: (input) => {
      rec.tokens.push(input);
      return Promise.resolve();
    },
    now: () => NOW,
    setupUrl: (token) => `http://localhost:8080/setup?token=${token}`,
    log: {
      info: (obj) => {
        rec.logs.push(obj);
      },
    },
    ...over,
  };
}

describe("bootstrap", () => {
  it("does nothing when a user already exists", async () => {
    const deps = makeDeps({ userCount: () => Promise.resolve(1) });
    const result = await bootstrap(deps, baseEnv());
    expect(result).toEqual({ kind: "already-initialized" });
    expect(deps.admins).toHaveLength(0);
    expect(deps.tokens).toHaveLength(0);
  });

  it("is idempotent across repeated runs — the admin is created exactly once", async () => {
    const admins: unknown[] = [];
    let users = 0;
    const deps: BootstrapDeps = {
      userCount: () => Promise.resolve(users),
      createAdmin: (input) => {
        admins.push(input);
        users = 1;
        return Promise.resolve();
      },
      createSetupToken: () => Promise.resolve(),
      now: () => NOW,
      setupUrl: (token) => `http://localhost:8080/setup?token=${token}`,
      log: { info: () => undefined },
    };
    const env = baseEnv({ SCHRODUMP_ADMIN_EMAIL: "a@b.c", SCHRODUMP_ADMIN_PASSWORD: "pw" });
    const first = await bootstrap(deps, env);
    const second = await bootstrap(deps, env);
    expect(first.kind).toBe("admin-created");
    expect(second.kind).toBe("already-initialized");
    expect(admins).toHaveLength(1);
  });

  it("creates the admin from env credentials", async () => {
    const deps = makeDeps();
    const result = await bootstrap(
      deps,
      baseEnv({ SCHRODUMP_ADMIN_EMAIL: "a@b.c", SCHRODUMP_ADMIN_PASSWORD: "pw" }),
    );
    expect(result).toEqual({ kind: "admin-created", email: "a@b.c" });
    expect(deps.admins).toEqual([{ email: "a@b.c", password: "pw" }]);
  });

  it("issues a setup token and logs the URL when no admin env is present", async () => {
    const deps = makeDeps();
    const result = await bootstrap(deps, baseEnv());
    expect(result).toEqual({ kind: "setup-token-issued" });
    expect(deps.tokens).toHaveLength(1);
    expect(deps.logs).toHaveLength(1);
  });
});
