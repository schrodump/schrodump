// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { instanceRoutes, type InstanceConfig } from "./instance.js";

const CONFIG: InstanceConfig = {
  version: "0.1.0-rc.1",
  scratchPath: "/var/lib/schrodump/scratch",
  scratchMaxBytes: 107374182400,
  maxConcurrentStaged: 2,
  stagedThresholdBytes: null,
  executorNetwork: "schrodump_targets",
  selfBackupDestinationId: null,
  selfBackupIntervalMs: 86400000,
  notifyMinGapMs: 900000,
  shutdownGraceMs: 8000,
};

async function appWith(role: Role | null, config: InstanceConfig = CONFIG) {
  const app = Fastify();
  const ctx: AuthContext | null =
    role === null ? null : { userId: "u", organizationId: "o", role, mustChangePassword: false };
  await app.register((instance) => {
    instanceRoutes({ resolver: () => Promise.resolve(ctx), config: () => config })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("GET /instance", () => {
  it("reports the configuration this process actually booted with", async () => {
    // The settings page said "this data needs a server endpoint that is not available yet" while
    // every value below was already decided at boot and knowable only by reading the operator's
    // own .env — which is exactly the file they come to the interface to avoid guessing about.
    const app = await appWith("admin");
    const res = await app.inject({ method: "GET", url: "/instance" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: "0.1.0-rc.1",
      scratch: {
        configured: true,
        path: "/var/lib/schrodump/scratch",
        maxBytes: 107374182400,
        maxConcurrentStaged: 2,
      },
      stagedThresholdBytes: null,
      executorNetwork: "schrodump_targets",
      selfBackup: { configured: false, intervalMs: 86400000 },
      notifyMinGapMs: 900000,
      shutdownGraceMs: 8000,
    });
    await app.close();
  });

  it("says scratch is unconfigured rather than inventing a path", async () => {
    // Absent scratch is STREAM-only: no staged dump, no verify sandbox, no restore. It is the
    // single most consequential thing about a deployment's capabilities, and it is a real state.
    const app = await appWith("admin", { ...CONFIG, scratchPath: null });
    const res = await app.inject({ method: "GET", url: "/instance" });
    expect(res.json().scratch).toEqual({
      configured: false,
      path: null,
      maxBytes: 107374182400,
      maxConcurrentStaged: 2,
    });
    await app.close();
  });

  it("reports self-backup as configured when a destination is set, without naming it twice", async () => {
    const app = await appWith("admin", { ...CONFIG, selfBackupDestinationId: "dest-1" });
    expect(res_selfBackup(await app.inject({ method: "GET", url: "/instance" }))).toEqual({
      configured: true,
      intervalMs: 86400000,
    });
    await app.close();
  });

  it("is refused to an operator and to a viewer — this is deployment configuration", async () => {
    for (const role of ["operator", "viewer"] as const) {
      const app = await appWith(role);
      expect((await app.inject({ method: "GET", url: "/instance" })).statusCode).toBe(403);
      await app.close();
    }
  });

  it("is refused without a session", async () => {
    const app = await appWith(null);
    expect((await app.inject({ method: "GET", url: "/instance" })).statusCode).toBe(401);
    await app.close();
  });

  it("carries no secret, whatever else it grows", async () => {
    // The guard on the next person to add a field here: the process environment this reads from
    // also holds DATABASE_URL and SCHRODUMP_KEK, and losing the KEK loses every backup.
    const app = await appWith("admin");
    const body = (await app.inject({ method: "GET", url: "/instance" })).body;
    for (const forbidden of ["KEK", "DATABASE_URL", "password", "secret", "postgres://"]) {
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    await app.close();
  });
});

function res_selfBackup(res: { json: () => { selfBackup: unknown } }) {
  return res.json().selfBackup;
}
