// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Email delivery.
//
// Same rules as the webhook: the payload carries counts, ids and a summary, never a connection
// string, a credential or a sample of data. The SMTP password authenticates the sender and never
// appears in a message.

import nodemailer from "nodemailer";
import type { Notification } from "./evaluate.js";

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
}

export const defaultSmtpDeps: SmtpDeps = {
  createTransport: (options) => nodemailer.createTransport(options) as unknown as SmtpTransport,
};

// The subject is what an operator actually reads while scanning an inbox. A resolution that looks
// identical to an alert is how a mailbox rule ends up filtering both.
function subjectFor(notification: Notification): string {
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
  notification: Notification,
): Promise<void> {
  const transport = deps.createTransport({
    host: target.host,
    port: target.port,
    auth: { user: target.username, pass: target.password },
    // Not a flag. A notification carries the fleet's state across someone else's network; sending
    // it in the clear is not a tradeoff worth configuring.
    requireTLS: true,
  });

  await transport.sendMail({
    from: target.from,
    to: target.to.join(", "),
    subject: subjectFor(notification),
    text: `${notification.summary}\n\ntrigger: ${notification.trigger}\nkey: ${notification.key || "(fleet-wide)"}\n`,
  });
}
