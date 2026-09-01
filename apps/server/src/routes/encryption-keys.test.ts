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
  const rotate =
    over.rotate ??
    vi.fn().mockResolvedValue({
      retiredKeyId: "old-1",
      newKeyId: "new-1",
      escrowIdentity: null,
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
      rotate,
    })(instance);
    return Promise.resolve();
  });
  return { app, provision, rotate };
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

describe("POST /encryption-keys/rotate", () => {
  const ACTIVE: EncryptionKeyRecord[] = [
    { keyId: "op-1", type: "operational", publicRecipient: "age1op", state: "active" },
    { keyId: "esc-1", type: "escrow", publicRecipient: "age1esc", state: "active" },
  ];

  it("rotates the operational key and reports what rotation did NOT do", async () => {
    const { app, rotate } = await appWith("admin", { existing: () => Promise.resolve(ACTIVE) });

    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys/rotate",
      payload: { type: "operational" },
    });

    expect(res.statusCode).toBe(201);
    expect(rotate).toHaveBeenCalledWith("o", { type: "operational" });
    const body = JSON.parse(res.body) as {
      retiredKeyId: string;
      newKeyId: string;
      escrowIdentity: string | null;
      consequences: {
        existingArtifactsUnchanged: boolean;
        predecessorReadableByServer: boolean;
        operatorMustRetain: string | null;
        doesNotRemediateExposure: string;
      };
    };
    expect(body.retiredKeyId).toBe("old-1");
    expect(body.newKeyId).toBe("new-1");
    // Nothing to copy down: the server keeps the operational identity itself.
    expect(body.escrowIdentity).toBeNull();
    expect(body.consequences.existingArtifactsUnchanged).toBe(true);
    expect(body.consequences.predecessorReadableByServer).toBe(true);
    expect(body.consequences.operatorMustRetain).toBeNull();
    // The point of the whole payload: a rotation that answered with an id alone would read as
    // "exposure handled", and it is not.
    expect(body.consequences.doesNotRemediateExposure).toContain("already written");
  });

  it("returns a generated escrow identity once, and says to keep the OLD one", async () => {
    const rotate = vi.fn().mockResolvedValue({
      retiredKeyId: "esc-1",
      newKeyId: "esc-2",
      escrowIdentity: "AGE-SECRET-KEY-1NEWESCROW",
    });
    const { app } = await appWith("admin", { existing: () => Promise.resolve(ACTIVE), rotate });

    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys/rotate",
      payload: { type: "escrow", escrow: { mode: "generate" } },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      escrowIdentity: string;
      escrowIdentityWarning: string;
      consequences: { predecessorReadableByServer: boolean; operatorMustRetain: string };
    };
    expect(body.escrowIdentity).toBe("AGE-SECRET-KEY-1NEWESCROW");
    expect(body.escrowIdentityWarning).toContain("shown once");
    // The sharp edge: the server never held the outgoing escrow identity, so if the operator
    // discards it, every artifact written before this rotation loses its recovery path.
    expect(body.consequences.predecessorReadableByServer).toBe(false);
    expect(body.consequences.operatorMustRetain).toContain("OUTGOING escrow identity");
  });

  it("accepts an operator-supplied escrow recipient and never invents one", async () => {
    const { recipient } = await generateAgeKeyPair();
    const { app, rotate } = await appWith("admin", { existing: () => Promise.resolve(ACTIVE) });

    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys/rotate",
      payload: { type: "escrow", escrow: { mode: "recipient", publicRecipient: recipient } },
    });

    expect(res.statusCode).toBe(201);
    expect(rotate).toHaveBeenCalledWith("o", {
      type: "escrow",
      escrow: { mode: "recipient", publicRecipient: recipient },
    });
  });

  it("refuses a malformed age recipient with the checksum, not a regex", async () => {
    const { recipient } = await generateAgeKeyPair();
    // One character transposed: still the right shape, wrong bech32 checksum.
    const broken = recipient.slice(0, -2) + (recipient.endsWith("a") ? "bb" : "aa");
    const { app, rotate } = await appWith("admin", { existing: () => Promise.resolve(ACTIVE) });

    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys/rotate",
      payload: { type: "escrow", escrow: { mode: "recipient", publicRecipient: broken } },
    });

    expect(res.statusCode).toBe(400);
    expect(rotate).not.toHaveBeenCalled();
  });

  it("answers 409 when the type was never provisioned", async () => {
    // Provisioning is the operation here, and answering with a rotation would hide that this
    // organization never had an operational key at all.
    const { app, rotate } = await appWith("admin", {
      existing: () => Promise.resolve([ACTIVE[1] as EncryptionKeyRecord]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys/rotate",
      payload: { type: "operational" },
    });

    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { blockers: string[] }).blockers).toEqual(["not_provisioned"]);
    expect(rotate).not.toHaveBeenCalled();
  });

  it("answers 409 rather than guess when two active keys of the type exist", async () => {
    const { app, rotate } = await appWith("admin", {
      existing: () =>
        Promise.resolve([
          ...ACTIVE,
          { keyId: "op-2", type: "operational", publicRecipient: "age1op2", state: "active" },
        ] as EncryptionKeyRecord[]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys/rotate",
      payload: { type: "operational" },
    });

    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { blockers: string[] }).blockers).toEqual(["ambiguous_active"]);
    expect(rotate).not.toHaveBeenCalled();
  });

  it("rejects an unknown field instead of silently dropping it", async () => {
    // .strict() matters here: a caller who thinks they are pinning a recipient under the wrong key
    // name must not get a server-generated key instead.
    const { app, rotate } = await appWith("admin", { existing: () => Promise.resolve(ACTIVE) });

    const res = await app.inject({
      method: "POST",
      url: "/encryption-keys/rotate",
      payload: { type: "operational", publicRecipient: "age1whatever" },
    });

    expect(res.statusCode).toBe(400);
    expect(rotate).not.toHaveBeenCalled();
  });

  it("is refused for operator and viewer", async () => {
    for (const role of ["operator", "viewer"] as const) {
      const { app, rotate } = await appWith(role, { existing: () => Promise.resolve(ACTIVE) });

      const res = await app.inject({
        method: "POST",
        url: "/encryption-keys/rotate",
        payload: { type: "operational" },
      });

      expect(res.statusCode).toBe(403);
      expect(rotate).not.toHaveBeenCalled();
    }
  });
});
