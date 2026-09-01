// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Provisioning the two keys every backup is sealed to. Without them the first backup of a fresh
// install fails inside resolveRecipients and no interface offered a way to fix it.
//
// The two keys are not symmetric and the asymmetry is the design:
//
//   operational — the server holds the identity (KEK-wrapped) because it needs to decrypt in order
//                 to verify and to restore. Convenience, and a key that dies with the database.
//   escrow      — the server holds ONLY the public recipient. `encryptedIdentity` stays null. This
//                 is the key that survives losing the metadata database, and it is the only one
//                 that can open a self-backup (see docs/install.md).
//
// So the escrow identity is returned exactly once, in the response to its own creation, and never
// stored anywhere. An operator who does not save it has an escrow key that protects nothing — and
// the response says so rather than leaving them to infer it.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import type { EncryptionKeyRecord } from "../crypto/artifact.js";
import { isValidAgeRecipient, provisioningBlockers } from "../crypto/key-provisioning.js";

// .strict(): an unknown field is a 400, not silently dropped. A caller who thinks they are passing
// an escrow recipient under the wrong key name must not get a server-generated one instead.
const CreateSchema = z
  .object({
    escrow: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("generate") }).strict(),
      z
        .object({
          mode: z.literal("recipient"),
          // Validated by age itself, checksum included, so a transposed character is refused here
          // rather than discovered later as an artifact nobody can open.
          publicRecipient: z.string().refine(isValidAgeRecipient, {
            message: "not a valid age recipient",
          }),
        })
        .strict(),
    ]),
  })
  .strict();

export interface EncryptionKeyDTO {
  keyId: string;
  type: "operational" | "escrow";
  state: "active" | "retired";
  publicRecipient: string;
  // True when the server holds the identity and can therefore decrypt on its own. Always false for
  // escrow — that is what makes it escrow.
  serverCanDecrypt: boolean;
  createdAt: string;
}

export interface EncryptionKeyRoutesDeps {
  resolver: SessionResolver;
  list(organizationId: string): Promise<EncryptionKeyDTO[]>;
  existing(organizationId: string): Promise<EncryptionKeyRecord[]>;
  // Returns the escrow IDENTITY only when the server generated it. Null when the operator supplied
  // their own recipient, because then the server never saw a private key at all.
  provision(
    organizationId: string,
    escrow: { mode: "generate" } | { mode: "recipient"; publicRecipient: string },
  ): Promise<{ operationalKeyId: string; escrowKeyId: string; escrowIdentity: string | null }>;
}

export function encryptionKeyRoutes(deps: EncryptionKeyRoutesDeps) {
  return (app: FastifyInstance): void => {
    // Readable by any role: whether the deployment can take a backup at all is not a secret, and the
    // guided setup needs it. Identities are never in the payload, only public recipients.
    app.get(
      "/encryption-keys",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => reply.send(await deps.list(contextOf(request).organizationId)),
    );

    app.post(
      "/encryption-keys",
      { preHandler: [authenticate(deps.resolver), requireRole("admin")] },
      async (request, reply) => {
        const parsed = CreateSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid key request" });

        const organizationId = contextOf(request).organizationId;
        const blockers = provisioningBlockers(await deps.existing(organizationId));
        if (blockers.length > 0) {
          // 409, not 400: the request is well formed and would be valid on an organization without
          // keys. Rotation is a different operation and does not exist yet.
          return reply
            .status(409)
            .send({ error: "encryption keys already provisioned", blockers });
        }

        const result = await deps.provision(organizationId, parsed.data.escrow);
        return reply.status(201).send({
          operationalKeyId: result.operationalKeyId,
          escrowKeyId: result.escrowKeyId,
          // Present exactly once, in this response, and never retrievable again. The client is
          // expected to make the operator save it before moving on.
          escrowIdentity: result.escrowIdentity,
          escrowIdentityWarning:
            result.escrowIdentity === null
              ? null
              : "Save this now. It is shown once and never stored. Without it a self-backup cannot be recovered.",
        });
      },
    );
  };
}
