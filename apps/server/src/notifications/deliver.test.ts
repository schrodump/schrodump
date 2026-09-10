// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// One dispatch, two callers.
//
// The scheduled loop and the operator's "send a test" button have to reach the wire through the
// SAME function. A test button with a dispatch of its own would be worse than no button: it could
// report a healthy channel while every real notification failed — which is not hypothetical here.
// See secret-envelope.test.ts: a JSON.parse in exactly this seam meant webhook and SMTP had never
// delivered anything, permanently, while everything else about the feature looked correct.

import { describe, expect, it, vi } from "vitest";
import { encryptCredential } from "../crypto/envelope.js";
import { deliverToChannel, TEST_NOTIFICATION, type StoredChannel } from "./deliver.js";

const KEK = Buffer.alloc(32, 7);
const SIGNING_KEY = "example-example-example";

const DEPS = {
  kek: KEK,
  audit: { record: () => undefined },
  fetch: vi.fn(),
  smtp: { ca: null, createTransport: () => ({ sendMail: () => Promise.resolve({}) }) },
};

const WEBHOOK_CHANNEL: StoredChannel = {
  id: "chan-1",
  organizationId: "org-1",
  kind: "WEBHOOK",
  url: "https://hooks.example/x",
  encryptedSecret: JSON.stringify(encryptCredential(KEK, SIGNING_KEY)),
  smtpHost: null,
  smtpPort: null,
  smtpUsername: null,
  encryptedSmtpPassword: null,
  fromAddress: null,
  toAddresses: [],
};

const SMTP_CHANNEL: StoredChannel = {
  ...WEBHOOK_CHANNEL,
  kind: "SMTP",
  url: null,
  encryptedSecret: null,
  smtpHost: "smtp.example",
  smtpPort: 587,
  smtpUsername: "schrodump",
  encryptedSmtpPassword: JSON.stringify(encryptCredential(KEK, "s3cret-password")),
  fromAddress: "schrodump@example.com",
  toAddresses: ["ops@example.com"],
};

describe("deliverToChannel — the one path to the wire", () => {
  it("signs and posts a webhook, decrypting the stored secret on the way", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverToChannel({ ...DEPS, fetch: fetchMock }, WEBHOOK_CHANNEL, TEST_NOTIFICATION);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example/x");
    expect((init.headers as Record<string, string>)["X-Schrodump-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // The secret authenticates the sender; it is never itself transmitted.
    expect(JSON.stringify(init)).not.toContain(SIGNING_KEY);
  });

  it("sends the email, and never puts the SMTP password in the message", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await deliverToChannel(
      { ...DEPS, smtp: { ca: null, createTransport: () => ({ sendMail }) } },
      SMTP_CHANNEL,
      TEST_NOTIFICATION,
    );
    const message = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(message.to).toBe("ops@example.com");
    expect(JSON.stringify(message)).not.toContain("s3cret-password");
  });

  it("refuses a channel missing the fields its own kind needs, rather than reporting success", async () => {
    // The columns are nullable because one row is one kind. A row missing its own half is broken,
    // and saying so beats sending nothing and calling it delivered.
    await expect(
      deliverToChannel(DEPS, { ...SMTP_CHANNEL, fromAddress: null }, TEST_NOTIFICATION),
    ).rejects.toThrow(/missing/i);
    await expect(
      deliverToChannel(DEPS, { ...WEBHOOK_CHANNEL, encryptedSecret: null }, TEST_NOTIFICATION),
    ).rejects.toThrow(/missing/i);
  });
});

describe("a test delivery is unmistakably a test", () => {
  it("carries its own trigger, so a receiver never mistakes it for a real alert", () => {
    // The button exists to prove the channel works. If proving it meant faking an ARTIFACT_FAILED,
    // the proof would page whoever is on call with something that never happened.
    expect(TEST_NOTIFICATION.trigger).toBe("TEST");
  });

  it("says so in the subject line an operator actually reads", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await deliverToChannel(
      { ...DEPS, smtp: { ca: null, createTransport: () => ({ sendMail }) } },
      SMTP_CHANNEL,
      TEST_NOTIFICATION,
    );
    const subject = String((sendMail.mock.calls[0]?.[0] as Record<string, unknown>).subject);
    expect(subject).toMatch(/test/i);
    expect(subject).not.toMatch(/alert/i);
  });
});
