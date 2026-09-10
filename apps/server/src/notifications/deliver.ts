// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The one path from a stored channel to the wire.
//
// Two callers reach it: the scheduled loop in wiring.ts, and the operator pressing "send a test".
// They MUST be the same function. A test button with a dispatch of its own would be worse than no
// button — it could report a healthy channel while every real notification failed — and that is
// not a hypothetical in this repository. A JSON.parse in exactly this seam (see
// secret-envelope.test.ts) meant webhook and SMTP had never delivered anything, permanently, while
// every pure unit around it passed.

import { readCredential, type CredentialAuditSink } from "../crypto/credential-access.js";
import type { NotificationTrigger } from "./evaluate.js";
import { deliverEmail, type SmtpDeps } from "./smtp.js";
import { deliverWebhook } from "./webhook.js";

// The evaluator's three triggers are what a FLEET can be in. "TEST" is not one of them — nothing
// about the fleet produces it and it is never an open condition — so it widens the wire vocabulary
// only, and `evaluate.ts` keeps its exhaustive three.
export type DeliverableTrigger = NotificationTrigger | "TEST";

export interface DeliverableNotification {
  readonly trigger: DeliverableTrigger;
  readonly key: string;
  readonly kind: "opened" | "resolved";
  readonly summary: string;
}

// Deliberately not dressed as an alert. The button exists to prove the channel carries a message;
// if proving it meant faking an ARTIFACT_FAILED, the proof would page whoever is on call with
// something that never happened — and the next real alert would be trusted a little less.
export const TEST_NOTIFICATION: DeliverableNotification = {
  trigger: "TEST",
  key: "",
  kind: "resolved",
  summary: "This is a test delivery from Schrodump. Nothing is wrong; someone pressed the button.",
};

// The row as stored. Nullable columns because one row is one kind, exactly as the schema says.
export interface StoredChannel {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: string;
  readonly url: string | null;
  readonly encryptedSecret: string | null;
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly smtpUsername: string | null;
  readonly encryptedSmtpPassword: string | null;
  readonly fromAddress: string | null;
  readonly toAddresses: readonly string[];
}

export interface ChannelDeliveryDeps {
  readonly kek: Buffer;
  // Every decryption below is an art. 37 access. See crypto/credential-access.ts.
  readonly audit: CredentialAuditSink;
  readonly fetch: typeof fetch;
  readonly smtp: SmtpDeps;
}

// NotificationChannel stores its two credentials in String columns, not Json like every other
// encrypted credential in the schema, and the store writes them with JSON.stringify. Parsed here
// rather than migrated: the column shape is the store's business.
function envelopeFrom(stored: string): unknown {
  return JSON.parse(stored) as unknown;
}

export async function deliverToChannel(
  deps: ChannelDeliveryDeps,
  channel: StoredChannel,
  notification: DeliverableNotification,
): Promise<void> {
  // Dispatch on the discriminator, and read only the half that belongs to it. A channel missing
  // the fields its own kind needs is a broken row, and saying so beats sending nothing and calling
  // it delivered.
  if (channel.kind === "SMTP") {
    const { smtpHost, smtpPort, smtpUsername, encryptedSmtpPassword, fromAddress } = channel;
    if (
      smtpHost === null ||
      smtpPort === null ||
      smtpUsername === null ||
      encryptedSmtpPassword === null ||
      fromAddress === null ||
      channel.toAddresses.length === 0
    ) {
      throw new Error("SMTP channel is missing host, port, credentials, sender or recipients");
    }
    await deliverEmail(
      deps.smtp,
      {
        host: smtpHost,
        port: smtpPort,
        username: smtpUsername,
        password: readCredential(deps, envelopeFrom(encryptedSmtpPassword), {
          organizationId: channel.organizationId,
          resource: "notificationChannel",
          resourceId: channel.id,
          purpose: "notification: authenticate to the SMTP relay",
          correlationId: `notify:${channel.id}`,
        }),
        from: fromAddress,
        to: channel.toAddresses,
      },
      notification,
    );
    return;
  }

  const { url, encryptedSecret } = channel;
  if (url === null || encryptedSecret === null) {
    throw new Error("webhook channel is missing its url or signing secret");
  }
  await deliverWebhook(
    { fetch: deps.fetch },
    {
      url,
      secret: readCredential(deps, envelopeFrom(encryptedSecret), {
        organizationId: channel.organizationId,
        resource: "notificationChannel",
        resourceId: channel.id,
        purpose: "notification: sign the outgoing webhook",
        correlationId: `notify:${channel.id}`,
      }),
    },
    notification,
  );
}
