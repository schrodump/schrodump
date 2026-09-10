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
  type NotificationRoutesDeps,
  type TestDeliveryResult,
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
  lastSuccessAt: null,
  deliverJobEvents: false,
};

const STORE: ChannelStore = {
  create: () => Promise.resolve(RECORD),
  list: () => Promise.resolve([RECORD]),
  setEnabled: () => Promise.resolve({ ...RECORD, enabled: false }),
  remove: () => Promise.resolve(true),
};

const DELIVERED: TestDeliveryResult = {
  ok: true,
  channel: { ...RECORD, lastSuccessAt: new Date("2026-09-10T12:00:00.000Z") },
};

async function appWith(
  role: Role | null,
  over: Partial<ChannelStore> = {},
  testDelivery: NotificationRoutesDeps["testDelivery"] = () => Promise.resolve(DELIVERED),
) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role , mustChangePassword: false };
  await app.register((instance) => {
    notificationRoutes({
      resolver: () => Promise.resolve(ctx),
      kek: randomBytes(32),
      store: () => ({ ...STORE, ...over }),
      testDelivery,
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

// The rule was already enforced and already tested — "refuses a signing secret too short to be
// worth having" above asserts the 400. What no test asked was whether anyone could tell WHY, and
// the answer was no: every issue collapsed into `{ error: "invalid channel" }`. An operator pasting
// a webhook URL and a 14-character secret saw a refusal that named nothing, and reasonably
// concluded the URL was the problem. The schema's messages were written for a human to read; the
// route threw them away one line later.
describe("notification channels — a refusal names the field it refused", () => {
  it("names the secret, and repeats the schema's own sentence, when it is too short", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, secret: "short" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; field?: string; detail?: string };
    expect(body.field).toBe("secret");
    expect(body.detail).toContain("16 characters");
    await app.close();
  });

  it("names the url when the url is the problem, and does not blame it when it is not", async () => {
    const app = await appWith("operator");
    const bad = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, url: "services2.example.com/webhook" },
    });
    expect((bad.json() as { field?: string }).field).toBe("url");

    const good = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, secret: "short" },
    });
    expect((good.json() as { field?: string }).field).not.toBe("url");
    await app.close();
  });

  it("names the stray key when a webhook payload carries SMTP fields", async () => {
    // zod reports unrecognized_keys with an EMPTY path — the offending name is in `keys`, so a
    // naive path.join() would say the field is "" and leave the operator exactly where they were.
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, smtpHost: "smtp.example" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { field?: string }).field).toBe("smtpHost");
    await app.close();
  });

  it("never lets the payload's own values back out in the detail", async () => {
    // The whole reason these bodies were opaque. A channel body carries a signing secret and an
    // SMTP password; a validation reply that echoed what it received would be a credential leak
    // dressed as helpfulness. Paths and the schema's authored sentences only.
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...SMTP, smtpPort: 0, smtpPassword: "s3cret-password" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("s3cret-password");
    await app.close();
  });
});


// A channel that has been configured and never carried a single message is not "ready" — it is an
// open question, exactly like an artifact nobody has restored. This is the button that answers it,
// and it has to answer honestly in both directions.
describe("notification channels — proving one actually delivers", () => {
  it("reports a delivery that arrived, and when", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/notification-channels/c1/test" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; channel: { lastSuccessAt: string | null } };
    expect(body.ok).toBe(true);
    expect(body.channel.lastSuccessAt).not.toBeNull();
    await app.close();
  });

  it("reports a delivery that did not arrive, instead of a cheerful 200", async () => {
    // The whole point of the button. A test that cannot fail proves nothing at all.
    const app = await appWith("operator", {}, () =>
      Promise.resolve({
        ok: false,
        channel: {
          ...RECORD,
          lastFailureAt: new Date("2026-09-10T12:00:00.000Z"),
          lastFailure: "535 authentication failed",
        },
      }),
    );
    const res = await app.inject({ method: "POST", url: "/notification-channels/c1/test" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; channel: { lastFailure: string | null } };
    expect(body.ok).toBe(false);
    expect(body.channel.lastFailure).toContain("535");
    await app.close();
  });

  it("404s for a channel that is not there, rather than reporting a delivery to nowhere", async () => {
    const app = await appWith("operator", {}, () => Promise.resolve(null));
    const res = await app.inject({ method: "POST", url: "/notification-channels/nope/test" });
    expect(res.statusCode).toBe(404);
    // Named, not just a 404: Fastify answers an ABSENT ROUTE with 404 too, so a bare status
    // assertion here would pass with no route at all.
    expect((res.json() as { error: string }).error).toBe("channel not found");
    await app.close();
  });

  it("is not something a viewer can trigger", async () => {
    // It opens a real connection and sends a real message with the organization's credentials.
    const app = await appWith("viewer");
    const res = await app.inject({ method: "POST", url: "/notification-channels/c1/test" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("never returns the credential it just used", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/notification-channels/c1/test" });
    // Asserted first, or the two `not.toContain` below would hold happily against a 404's body.
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("encryptedSecret");
    expect(res.body).not.toContain("encryptedSmtpPassword");
    await app.close();
  });
});


// evaluate.ts stays fleet-level: the three triggers are what ALERTING is, and a channel that fires
// on every job is filtered into a folder within a week, taking them with it. The firehose is an
// axis added beside that decision, not a reversal of it — so it is off unless asked for.
describe("notification channels — the job firehose is opt-in", () => {
  it("defaults to off, because alerting is fleet-level", async () => {
    const seen: CreateChannelData[] = [];
    const app = await appWith("operator", {
      create: (data) => {
        seen.push(data);
        return Promise.resolve(RECORD);
      },
    });
    await app.inject({ method: "POST", url: "/notification-channels", payload: WEBHOOK });
    expect(seen[0]?.deliverJobEvents).toBe(false);
    await app.close();
  });

  it("carries the choice through to the store when it is asked for", async () => {
    const seen: CreateChannelData[] = [];
    const app = await appWith("operator", {
      create: (data) => {
        seen.push(data);
        return Promise.resolve(RECORD);
      },
    });
    await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...SMTP, deliverJobEvents: true },
    });
    expect(seen[0]?.deliverJobEvents).toBe(true);
    await app.close();
  });

  it("still refuses a stray field from the other kind", async () => {
    // .strict() is what makes "one row is one kind" enforceable at the edge. Adding an optional
    // field to both branches must not open a hole in that.
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, deliverJobEvents: true, smtpHost: "smtp.example" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { field?: string }).field).toBe("smtpHost");
    await app.close();
  });

  it("tells a reader which channels are subscribed to the firehose", async () => {
    const app = await appWith("viewer", {
      list: () => Promise.resolve([{ ...RECORD, deliverJobEvents: true }]),
    });
    const res = await app.inject({ method: "GET", url: "/notification-channels" });
    expect(res.body).toContain('"deliverJobEvents":true');
    await app.close();
  });
});
