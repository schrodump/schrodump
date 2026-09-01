// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Webhook delivery.
//
// A notification leaves the trust boundary, so the manifest's rules are the precedent: the payload
// carries counts, ids and a summary, and never a connection string, a credential or a sample of
// data. The signing secret authenticates the sender and is never itself transmitted.

import { createHmac } from "node:crypto";
import type { Notification } from "./evaluate.js";

export interface WebhookTarget {
  readonly url: string;
  // Envelope-encrypted at rest by the caller; plaintext only here, only to sign.
  readonly secret: string;
}

export interface WebhookDeps {
  readonly fetch: typeof fetch;
}

// HMAC over the EXACT bytes transmitted. Signing a re-serialisation would have the receiver verify
// something the sender never sent — the classic way a signature becomes decorative.
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Derived from the CONDITION, not from the moment: a receiver seeing the same condition twice (a
// retry, a replay) must be able to recognise it as the same one. Keying on time would make every
// delivery unique and defeat exactly that.
function idempotencyKey(notification: Notification): string {
  return createHmac("sha256", "schrodump-notification")
    .update(`${notification.trigger}:${notification.key}:${notification.kind}`)
    .digest("hex");
}

export async function deliverWebhook(
  deps: WebhookDeps,
  target: WebhookTarget,
  notification: Notification,
): Promise<void> {
  const body = JSON.stringify({
    trigger: notification.trigger,
    key: notification.key,
    kind: notification.kind,
    summary: notification.summary,
  });

  const response = await deps.fetch(target.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Schrodump-Signature": signBody(target.secret, body),
      "Idempotency-Key": idempotencyKey(notification),
    },
    body,
  });

  if (!response.ok) {
    // Thrown, not swallowed: a notifier that cannot reach its channel must not be quiet about it,
    // or the whole feature degrades into false comfort. The caller records the failure.
    throw new Error(`webhook delivery failed with status ${response.status}`);
  }
}
