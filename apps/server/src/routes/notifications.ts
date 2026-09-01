// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Notification channels: where an organization's open questions get sent.
//
// Same credential rule as every other resource — the webhook signing secret and the SMTP password
// are write-only. They go in, they are encrypted, and nothing ever reads them back out to a
// response. A channel's last delivery failure IS returned, because a notifier nobody can tell is
// broken is worse than having none.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import { encryptCredential, type EncryptedCredential } from "../crypto/envelope.js";

// A channel is one kind or the other, and the schema says so rather than accepting a bag of
// optional fields and discovering at delivery time that half of them are missing.
const CreateChannelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("WEBHOOK"),
      url: z.url(),
      // Write-only: encrypted into encryptedSecret, never echoed.
      secret: z.string().min(16, "a signing secret shorter than 16 characters is not worth having"),
    })
    // .strict() is what makes "one row is one kind" enforceable at the edge. Without it zod strips
    // unknown keys, so a webhook payload carrying SMTP fields is silently accepted as a webhook and
    // the mistake is only discovered at delivery time, on a row that is half a channel.
    .strict(),
  z
    .object({
      kind: z.literal("SMTP"),
      smtpHost: z.string().min(1),
      smtpPort: z.number().int().positive(),
      smtpUsername: z.string().min(1),
      smtpPassword: z.string().min(1),
      fromAddress: z.email(),
      toAddresses: z.array(z.email()).min(1, "a channel with no recipients delivers nothing"),
    })
    .strict(),
]);

export interface CreateChannelData {
  kind: "WEBHOOK" | "SMTP";
  url?: string;
  encryptedSecret?: EncryptedCredential;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  encryptedSmtpPassword?: EncryptedCredential;
  fromAddress?: string;
  toAddresses?: string[];
}

export interface ChannelRecord {
  id: string;
  kind: string;
  url: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUsername: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  enabled: boolean;
  lastFailureAt: Date | null;
  lastFailure: string | null;
}

export interface ChannelStore {
  create(data: CreateChannelData): Promise<ChannelRecord>;
  list(): Promise<ChannelRecord[]>;
  setEnabled(id: string, enabled: boolean): Promise<ChannelRecord | null>;
  remove(id: string): Promise<boolean>;
}

export interface NotificationRoutesDeps {
  resolver: SessionResolver;
  store(organizationId: string): ChannelStore;
  kek: Buffer;
}

// Everything except the secrets. Explicit field list rather than a spread-minus-N: a field added to
// the record later has to be named here to be exposed, which is the direction that fails safe.
function toPublic(channel: ChannelRecord) {
  return {
    id: channel.id,
    kind: channel.kind,
    url: channel.url,
    smtpHost: channel.smtpHost,
    smtpPort: channel.smtpPort,
    smtpUsername: channel.smtpUsername,
    fromAddress: channel.fromAddress,
    toAddresses: channel.toAddresses,
    enabled: channel.enabled,
    lastFailureAt: channel.lastFailureAt,
    lastFailure: channel.lastFailure,
  };
}

export function notificationRoutes(deps: NotificationRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.post(
      "/notification-channels",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const parsed = CreateChannelSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid channel" });
        const input = parsed.data;
        const store = deps.store(contextOf(request).organizationId);

        const data: CreateChannelData =
          input.kind === "WEBHOOK"
            ? {
                kind: "WEBHOOK",
                url: input.url,
                encryptedSecret: encryptCredential(deps.kek, input.secret),
              }
            : {
                kind: "SMTP",
                smtpHost: input.smtpHost,
                smtpPort: input.smtpPort,
                smtpUsername: input.smtpUsername,
                encryptedSmtpPassword: encryptCredential(deps.kek, input.smtpPassword),
                fromAddress: input.fromAddress,
                toAddresses: input.toAddresses,
              };
        return reply.status(201).send(toPublic(await store.create(data)));
      },
    );

    app.get(
      "/notification-channels",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        const list = await deps.store(contextOf(request).organizationId).list();
        return reply.send(list.map(toPublic));
      },
    );

    // Disabling is the reversible operation and the one to reach for. Deleting a channel that is
    // recording delivery failures throws away the only evidence that it was failing.
    app.post(
      "/notification-channels/:id/enabled",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
        if (!params.success || !body.success)
          return reply.status(400).send({ error: "invalid request" });
        const updated = await deps
          .store(contextOf(request).organizationId)
          .setEnabled(params.data.id, body.data.enabled);
        if (updated === null) return reply.status(404).send({ error: "channel not found" });
        return reply.send(toPublic(updated));
      },
    );

    app.delete(
      "/notification-channels/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const removed = await deps.store(contextOf(request).organizationId).remove(params.data.id);
        if (!removed) return reply.status(404).send({ error: "channel not found" });
        return reply.status(204).send();
      },
    );
  };
}
