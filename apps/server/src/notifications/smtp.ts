// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Email delivery.
//
// Same rules as the webhook: the payload carries counts, ids and a summary, never a connection
// string, a credential or a sample of data. The SMTP password authenticates the sender and never
// appears in a message.

import nodemailer from "nodemailer";
import type { DeliverableNotification } from "./deliver.js";

// Long enough for a slow relay on a bad link, short enough that an operator waiting on the "send a
// test" button gets an answer rather than a spinner.
const DELIVERY_TIMEOUT_MS = 15_000;

export interface SmtpTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  // Envelope-encrypted at rest by the caller; plaintext only here, only to authenticate.
  readonly password: string;
  readonly from: string;
  readonly to: readonly string[];
}

export interface SmtpTransport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

export interface SmtpDeps {
  createTransport(options: Record<string, unknown>): SmtpTransport;
  // PEM of an additional CA to trust, or null for the system store alone. Deployment configuration
  // rather than per-channel: whose certificates this process trusts is a property of where it runs,
  // not of who is being emailed.
  readonly ca: string | null;
}

// `ca` ADDS trust; it never removes any. There is deliberately no way to reach
// `rejectUnauthorized: false` from configuration — an operator who cannot produce their CA must
// not be one keystroke away from sending the fleet's state to whoever answers on port 587.
export function smtpDeps(ca: string | null): SmtpDeps {
  return {
    ca,
    createTransport: (options) => nodemailer.createTransport(options) as unknown as SmtpTransport,
  };
}

// The subject is what an operator actually reads while scanning an inbox. A resolution that looks
// identical to an alert is how a mailbox rule ends up filtering both.
function subjectFor(notification: DeliverableNotification): string {
  // A test is not an alert and must not arrive looking like one. Without this case it fell through
  // to the final else and announced itself as a policy gone quiet — a button meant to prove the
  // channel works, lying about the fleet to do it.
  if (notification.trigger === "TEST") return "[schrodump] Test: this channel is reachable";
  const state = notification.kind === "resolved" ? "Resolved" : "Alert";
  const what =
    notification.trigger === "ARTIFACT_FAILED"
      ? "an artifact failed verification"
      : notification.trigger === "VERIFICATION_BEHIND"
        ? "verification is falling behind"
        : "a policy has gone quiet";
  return `[schrodump] ${state}: ${what}`;
}

export async function deliverEmail(
  deps: SmtpDeps,
  target: SmtpTarget,
  notification: DeliverableNotification,
): Promise<void> {
  const transport = deps.createTransport({
    host: target.host,
    port: target.port,
    auth: { user: target.username, pass: target.password },
    // Not a flag. A notification carries the fleet's state across someone else's network; sending
    // it in the clear is not a tradeoff worth configuring.
    requireTLS: true,
    // All three stages, because a host can fail at any of them and only the first has a default
    // worth relying on. This path now runs inside an operator's HTTP request as well as inside the
    // scheduler tick: a relay that accepts the TCP connection and then says nothing would otherwise
    // hold that request open with nothing anywhere in the path to end it.
    connectionTimeout: DELIVERY_TIMEOUT_MS,
    greetingTimeout: DELIVERY_TIMEOUT_MS,
    socketTimeout: DELIVERY_TIMEOUT_MS,
    // Omitted entirely when there is no extra CA, so the default path keeps Node's system store
    // rather than being handed a `tls` object that quietly narrows it.
    ...(deps.ca !== null ? { tls: { ca: deps.ca } } : {}),
  });

  await transport.sendMail({
    from: target.from,
    to: target.to.join(", "),
    subject: subjectFor(notification),
    text: `${notification.summary}\n\ntrigger: ${notification.trigger}\nkey: ${notification.key || "(fleet-wide)"}\n`,
  });
}
