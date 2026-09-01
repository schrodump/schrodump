// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Rotation's one non-negotiable property: an artifact sealed to the OUTGOING key must still open
// after the rotation.
//
// This cannot be proven with mocks. The claim is about a real row surviving a real transaction with
// its encryptedIdentity intact, and about the real age library opening a real ciphertext with the
// identity that comes back out of that row through the KEK. Every one of those is a place the
// property could be lost silently — and the loss would only surface at a restore, months later,
// which is the failure this whole product exists to prevent.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptStream, encryptStream, resolveDecryptionKeyId, resolveRecipients } from "../crypto/artifact.js";
import { decryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import { rotationBlockers } from "../crypto/key-rotation.js";
import { selectSelfBackupRecipients } from "../jobs/self-backup.js";
import { createEncryptionKeyService } from "./wiring.js";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const KEK = Buffer.alloc(32, 7);
const PLAINTEXT = "sealed before the rotation";

// Buffer in, Buffer out. age ciphertext is binary, and round-tripping it through a utf8 string
// silently mangles bytes — which surfaces as "invalid tag" from the AEAD and looks exactly like a
// wrong key.
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe.skipIf(!enabled)("rotating an encryption key (integration)", () => {
  let container: StartedTestContainer;
  let prisma: PrismaClient;
  let organizationId: string;

  beforeAll(async () => {
    container = await new GenericContainer(
      process.env.SCHRODUMP_TEST_POSTGRES_IMAGE ?? "postgres:18-alpine",
    )
      .withEnvironment({
        POSTGRES_USER: "schrodump",
        POSTGRES_PASSWORD: "schrodump",
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      .withHealthCheck({
        test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d app"],
        interval: 1000,
        timeout: 3000,
        retries: 30,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    const url = `postgresql://schrodump:schrodump@${container.getHost()}:${container.getMappedPort(5432)}/app?schema=public`;
    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: url },
    });
    prisma = new PrismaClient({ datasourceUrl: url });
    const org = await prisma.organization.create({
      data: { name: "rotating", slug: `rotating-${Date.now()}` },
    });
    organizationId = org.id;
  }, 240_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
    if (container !== undefined) await container.stop();
  });

  it("keeps an artifact sealed to the outgoing operational key readable", async () => {
    const service = createEncryptionKeyService(prisma, KEK);
    await service.provision(organizationId, { mode: "generate" });

    // Seal something with the keys as they stand today — this is the artifact that must survive.
    const before = resolveRecipients(await service.existing(organizationId));
    const ciphertext = await collect(
      await encryptStream(Readable.from([Buffer.from(PLAINTEXT, "utf8")]), before.recipients),
    );

    const rotated = await service.rotate(organizationId, { type: "operational" });

    // The successor is what NEW backups will seal to...
    const after = resolveRecipients(await service.existing(organizationId));
    expect(after.keyIds).not.toEqual(before.keyIds);
    expect(after.keyIds[0]).toBe(rotated.newKeyId);

    // ...and the predecessor is still resolvable FROM THE MANIFEST, which is the mechanism that
    // makes rotation safe: restore reads keyIds off the artifact, never off current config.
    const keyId = resolveDecryptionKeyId(before.keyIds, await service.existing(organizationId));
    expect(keyId).toBe(rotated.retiredKeyId);

    // The whole point, end to end: the retired row's identity still opens the old ciphertext.
    const retired = await prisma.encryptionKey.findFirstOrThrow({
      where: { organizationId, keyId: rotated.retiredKeyId },
    });
    expect(retired.state).toBe("retired");
    expect(retired.retiredAt).not.toBeNull();
    // If the rotation had cleared this column, every artifact sealed to it would be unopenable —
    // and nothing would have said so until a restore failed.
    expect(retired.encryptedIdentity).not.toBeNull();

    const identity = decryptCredential(KEK, parseEncryptedCredential(retired.encryptedIdentity));
    const opened = await collect(await decryptStream(Readable.from([ciphertext]), identity));
    expect(opened.toString("utf8")).toBe(PLAINTEXT);
  }, 120_000);

  it("leaves exactly one active key per type, so resolveRecipients never picks by row order", async () => {
    const service = createEncryptionKeyService(prisma, KEK);
    const active = (await service.existing(organizationId)).filter((k) => k.state === "active");

    expect(active.filter((k) => k.type === "operational")).toHaveLength(1);
    expect(active.filter((k) => k.type === "escrow")).toHaveLength(1);
    // And the state the route refuses to resolve by guessing is genuinely absent.
    expect(rotationBlockers(await service.existing(organizationId), "operational")).toEqual([]);
  });

  it("never writes an escrow identity, on rotation any more than on provisioning", async () => {
    const service = createEncryptionKeyService(prisma, KEK);

    const rotated = await service.rotate(organizationId, {
      type: "escrow",
      escrow: { mode: "generate" },
    });
    expect(rotated.escrowIdentity).toMatch(/^AGE-SECRET-KEY-/);

    const row = await prisma.encryptionKey.findFirstOrThrow({
      where: { organizationId, keyId: rotated.newKeyId },
    });
    // Checked against the real column, not against what the service was handed. This is the claim
    // that makes escrow worth having, and rotation is a new place to lose it.
    expect(row.encryptedIdentity).toBeNull();
    expect(row.type).toBe("escrow");
    expect(row.state).toBe("active");

    // The self-backup's stricter rule still holds afterwards: it seals to the NEW escrow.
    const recipients = selectSelfBackupRecipients(await service.existing(organizationId));
    expect(recipients.keyIds).toContain(rotated.newKeyId);
    expect(recipients.keyIds).not.toContain(rotated.retiredKeyId);
  }, 120_000);

  it("accepts an operator-supplied escrow recipient without ever holding its identity", async () => {
    const service = createEncryptionKeyService(prisma, KEK);
    // A recipient whose identity this process generates and then drops on the floor — the same
    // shape as an operator pasting one from an offline machine.
    const { generateAgeKeyPair } = await import("../crypto/artifact.js");
    const offline = await generateAgeKeyPair();

    const rotated = await service.rotate(organizationId, {
      type: "escrow",
      escrow: { mode: "recipient", publicRecipient: offline.recipient },
    });

    // Null, not the identity we happen to have in scope: the server must never have seen it.
    expect(rotated.escrowIdentity).toBeNull();
    const row = await prisma.encryptionKey.findFirstOrThrow({
      where: { organizationId, keyId: rotated.newKeyId },
    });
    expect(row.publicRecipient).toBe(offline.recipient);
    expect(row.encryptedIdentity).toBeNull();
  }, 120_000);

  it("refuses to rotate a type that was never provisioned", async () => {
    const service = createEncryptionKeyService(prisma, KEK);
    const other = await prisma.organization.create({
      data: { name: "bare", slug: `bare-${Date.now()}` },
    });

    expect(rotationBlockers(await service.existing(other.id), "operational")).toEqual([
      "not_provisioned",
    ]);
    await expect(service.rotate(other.id, { type: "operational" })).rejects.toThrow(/no active/);
  }, 120_000);
});
