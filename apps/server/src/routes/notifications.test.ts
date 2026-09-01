// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import {
  notificationRoutes,
  type ChannelRecord,
  type ChannelStore,
  type CreateChannelData,
} from "./notifications.js";

const RECORD: ChannelRecord = {
  id: "c1",
  kind: "WEBHOOK",
  url: "https://hooks.example/x",
  smtpHost: null,
  smtpPort: null,
  smtpUsername: null,
  fromAddress: null,
  toAddresses: [],
  enabled: true,
  lastFailureAt: null,
  lastFailure: null,
};

const STORE: ChannelStore = {
  create: () => Promise.resolve(RECORD),
  list: () => Promise.resolve([RECORD]),
  setEnabled: () => Promise.resolve({ ...RECORD, enabled: false }),
  remove: () => Promise.resolve(true),
};

async function appWith(role: Role | null, over: Partial<ChannelStore> = {}) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    notificationRoutes({
      resolver: () => Promise.resolve(ctx),
      kek: randomBytes(32),
      store: () => ({ ...STORE, ...over }),
    })(instance);
    return Promise.resolve();
  });
  return app;
}

const WEBHOOK = {
  kind: "WEBHOOK",
  url: "https://hooks.example/x",
  secret: "a-signing-secret-value",
};
const SMTP = {
  kind: "SMTP",
  smtpHost: "smtp.example",
  smtpPort: 587,
  smtpUsername: "schrodump",
  smtpPassword: "s3cret-password",
  fromAddress: "schrodump@example.com",
  toAddresses: ["ops@example.com"],
};

describe("notification channels — secrets are write-only", () => {
  it("never echoes the webhook signing secret", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: WEBHOOK,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("a-signing-secret-value");
    expect(res.body).not.toContain("encryptedSecret");
    await app.close();
  });

  it("never echoes the SMTP password", async () => {
    const seen: CreateChannelData[] = [];
    const app = await appWith("operator", {
      create: (data) => {
        seen.push(data);
        return Promise.resolve(RECORD);
      },
    });
    const res = await app.inject({ method: "POST", url: "/notification-channels", payload: SMTP });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("s3cret-password");
    // It reached the store encrypted, not in the clear.
    expect(JSON.stringify(seen[0]?.encryptedSmtpPassword)).not.toContain("s3cret-password");
    await app.close();
  });
});

describe("notification channels — the shape is a discriminated union, not a bag of optionals", () => {
  it("refuses a webhook payload carrying SMTP fields", async () => {
    // Accepting a mixed payload means discovering at delivery time that the row is half a channel.
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, smtpHost: "smtp.example" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses an SMTP channel with no recipients", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...SMTP, toAddresses: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses a signing secret too short to be worth having", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, secret: "short" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("notification channels — access", () => {
  it("lets a viewer read channels but not create one", async () => {
    const viewer = await appWith("viewer");
    expect((await viewer.inject({ method: "GET", url: "/notification-channels" })).statusCode).toBe(
      200,
    );
    const denied = await viewer.inject({
      method: "POST",
      url: "/notification-channels",
      payload: WEBHOOK,
    });
    expect(denied.statusCode).toBe(403);
    await viewer.close();
  });

  it("surfaces a channel's last delivery failure, which is the point of recording it", async () => {
    const failing = { ...RECORD, lastFailure: "webhook delivery failed with status 500" };
    const app = await appWith("viewer", { list: () => Promise.resolve([failing]) });
    const res = await app.inject({ method: "GET", url: "/notification-channels" });
    expect(res.body).toContain("status 500");
    await app.close();
  });

  it("404s when disabling or deleting a channel that is not there", async () => {
    const app = await appWith("operator", {
      setEnabled: () => Promise.resolve(null),
      remove: () => Promise.resolve(false),
    });
    const disable = await app.inject({
      method: "POST",
      url: "/notification-channels/nope/enabled",
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: "/notification-channels/nope" })).statusCode,
    ).toBe(404);
    await app.close();
  });
});
