// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Webhook delivery.
//
// A notification leaves the trust boundary, so the manifest's rules are the precedent: the payload
// carries counts, ids and a summary, and never a connection string, a credential or a sample of
// data. The signing secret authenticates the sender and is never itself transmitted.

import { createHmac } from "node:crypto";
import type { EgressGuard } from "../egress/guard.js";
import type { DeliverableNotification } from "./deliver.js";

// Node's fetch has no default timeout whatsoever: without this, a receiver that accepts the
// connection and never responds holds the caller until the process dies. That was survivable when
// delivery only ran inside the scheduler tick; it now also runs inside an operator's HTTP request.
const DELIVERY_TIMEOUT_MS = 15_000;

// A redirect is the way around a check made before the request: the URL an operator saved points
// at a host they own, and its 302 points at `docker-proxy:2375`. So the guard runs on every hop,
// not only the first, and the chain is followed by hand — `redirect: "follow"` would hand the whole
// chain to undici, where there is no seam to check anything. The cap is fetch's own.
const MAX_REDIRECTS = 20;

export interface WebhookTarget {
  readonly url: string;
  // Envelope-encrypted at rest by the caller; plaintext only here, only to sign.
  readonly secret: string;
}

export interface WebhookDeps {
  readonly fetch: typeof fetch;
  // Required, not optional: a delivery path that can be constructed without one is a delivery path
  // the next caller constructs without one. See egress/guard.ts.
  readonly egress: EgressGuard;
}

// HMAC over the EXACT bytes transmitted. Signing a re-serialisation would have the receiver verify
// something the sender never sent — the classic way a signature becomes decorative.
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Derived from the CONDITION, not from the moment: a receiver seeing the same condition twice (a
// retry, a replay) must be able to recognise it as the same one. Keying on time would make every
// delivery unique and defeat exactly that.
function idempotencyKey(notification: DeliverableNotification): string {
  return createHmac("sha256", "schrodump-notification")
    // The job's state joins the key. Without it every transition of one job carries the same key,
    // and a receiver that deduplicates — which is precisely what this header asks it to do — keeps
    // one delivery out of three. Empty for the fleet triggers, so their key is unchanged.
    .update(
      `${notification.trigger}:${notification.key}:${notification.kind}:${notification.job?.state ?? ""}`,
    )
    .digest("hex");
}

// 303 always becomes a GET; 301 and 302 do too, because that is what every client on the web does
// with a POST and what a receiver redirecting one expects. 307 and 308 keep the method and the
// body, which is what they exist to say.
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// POST the body to the URL, following redirects ourselves so the guard sees every hop. One timeout
// covers the whole chain rather than one per hop: five slow redirects should not buy five times the
// budget an operator is waiting on.
async function postGuarded(
  deps: WebhookDeps,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
  let current = url;
  let method = "POST";
  let sent: Record<string, string> = headers;
  let payload: string | undefined = body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await deps.egress.assertUrl("url", current);
    const response = await deps.fetch(current, {
      method,
      headers: sent,
      ...(payload !== undefined ? { body: payload } : {}),
      redirect: "manual",
      signal,
    });
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    // A 3xx with no Location is not a redirect anybody can follow; report it as the answer it is.
    if (location === null) return response;
    current = new URL(location, current).toString();
    if (response.status !== 307 && response.status !== 308) {
      method = "GET";
      payload = undefined;
      // The signature and the idempotency key stay — they identify this sender and this
      // condition, not this body. Content-Type goes with the body it described.
      sent = Object.fromEntries(
        Object.entries(sent).filter(([name]) => name.toLowerCase() !== "content-type"),
      );
    }
  }
  throw new Error(`webhook delivery followed ${String(MAX_REDIRECTS)} redirects without arriving`);
}

export async function deliverWebhook(
  deps: WebhookDeps,
  target: WebhookTarget,
  notification: DeliverableNotification,
): Promise<void> {
  const body = JSON.stringify({
    trigger: notification.trigger,
    key: notification.key,
    kind: notification.kind,
    summary: notification.summary,
    ...(notification.job !== undefined ? { job: notification.job } : {}),
  });

  const response = await postGuarded(deps, target.url, body, {
    "Content-Type": "application/json",
    "X-Schrodump-Signature": signBody(target.secret, body),
    "Idempotency-Key": idempotencyKey(notification),
  });

  if (!response.ok) {
    // Thrown, not swallowed: a notifier that cannot reach its channel must not be quiet about it,
    // or the whole feature degrades into false comfort. The caller records the failure.
    throw new Error(`webhook delivery failed with status ${response.status}`);
  }
}
