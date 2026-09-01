// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { generateAgeKeyPair, type EncryptionKeyRecord } from "../crypto/artifact.js";
import { encryptionKeyRoutes, type EncryptionKeyRoutesDeps } from "./encryption-keys.js";

async function appWith(role: Role | null, over: Partial<EncryptionKeyRoutesDeps> = {}) {
  // The override wins, and the harness must hand back the spy that was actually wired in — asserting
  // on the default while the route called the override is a test that proves nothing.
  const provision =
    over.provision ??
    vi.fn().mockResolvedValue({
      operationalKeyId: "op-1",
      escrowKeyId: "esc-1",
      escrowIdentity: "AGE-SECRET-KEY-1TESTONLY",
    });
  const app = Fastify();
  const ctx: AuthContext | null =
    role === null ? null : { userId: "u", organizationId: "o", role, mustChangePassword: false };
  await app.register((instance) => {
    encryptionKeyRoutes({
      resolver: () => Promise.resolve(ctx),
      list: () => Promise.resolve([]),
      existing: () => Promise.resolve([] as EncryptionKeyRecord[]),
      ...over,
      provision,
    })(instance);
    return Promise.resolve();
  });
  return { app, provision };
}

describe("POST /encryption-keys", () => {
  it("provisions both keys and returns the escrow identity exactly once", async () => {
    const { app } = await appWith("admin");
    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys",
      payload: { escrow: { mode: "generate" } },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { escrowIdentity: string; escrowIdentityWarning: string };
    expect(body.escrowIdentity).toBe("AGE-SECRET-KEY-1TESTONLY");
    // The warning is part of the contract, not decoration: this value is never retrievable again,
    // and an operator who closes the tab without saving it has an escrow key protecting nothing.
    expect(body.escrowIdentityWarning).toMatch(/shown once/i);
    await app.close();
  });

  it("returns no identity when the operator supplied their own recipient", async () => {
    const recipient = (await generateAgeKeyPair()).recipient;
    const { app, provision } = await appWith("admin", {
      provision: vi.fn().mockResolvedValue({
        operationalKeyId: "op-1",
        escrowKeyId: "esc-1",
        escrowIdentity: null,
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys",
      payload: { escrow: { mode: "recipient", publicRecipient: recipient } },
    });
    expect(res.statusCode).toBe(201);
    // Null because the server never saw a private key. That is the stronger posture and the
    // response must not imply otherwise by inventing a warning about saving something.
    expect(JSON.parse(res.body)).toMatchObject({
      escrowIdentity: null,
      escrowIdentityWarning: null,
    });
    expect(provision).toHaveBeenCalledWith("o", { mode: "recipient", publicRecipient: recipient });
    await app.close();
  });

  // age validates the bech32 checksum, so this catches a transposed character — the failure that
  // would otherwise surface months later as an artifact nobody can open.
  it("refuses a corrupted recipient", async () => {
    const good = (await generateAgeKeyPair()).recipient;
    const { app, provision } = await appWith("admin");
    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys",
      payload: {
        escrow: {
          mode: "recipient",
          publicRecipient: `${good.slice(0, -1)}${good.endsWith("q") ? "p" : "q"}`,
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(provision).not.toHaveBeenCalled();
    await app.close();
  });

  // .strict() on the union: a caller passing publicRecipient under mode "generate" must not
  // silently get a server-generated escrow key while believing they supplied their own.
  it("refuses an unknown field rather than dropping it", async () => {
    const { app, provision } = await appWith("admin");
    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys",
      payload: { escrow: { mode: "generate", publicRecipient: "age1whatever" } },
    });
    expect(res.statusCode).toBe(400);
    expect(provision).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses when an active key of that type already exists", async () => {
    const { app, provision } = await appWith("admin", {
      existing: () =>
        Promise.resolve([
          { keyId: "op-0", type: "operational", publicRecipient: "age1x", state: "active" },
        ]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys",
      payload: { escrow: { mode: "generate" } },
    });
    // 409 rather than 400: the request is well formed, the state is what refuses it.
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ blockers: ["operational"] });
    expect(provision).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses an operator (admin only)", async () => {
    const { app, provision } = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys",
      payload: { escrow: { mode: "generate" } },
    });
    expect(res.statusCode).toBe(403);
    expect(provision).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /encryption-keys", () => {
  it("lets a viewer see whether the deployment can take a backup at all", async () => {
    const { app } = await appWith("viewer", {
      list: () =>
        Promise.resolve([
          {
            keyId: "esc-1",
            type: "escrow",
            state: "active",
            publicRecipient: "age1escrow",
            serverCanDecrypt: false,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ]),
    });
    const res = await app.inject({ method: "GET", url: "/encryption-keys" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { publicRecipient: string }[];
    // Public recipients only. An identity in this payload would be the whole point of escrow lost.
    expect(body[0]?.publicRecipient).toBe("age1escrow");
    expect(res.body).not.toContain("AGE-SECRET-KEY");
    await app.close();
  });
});
