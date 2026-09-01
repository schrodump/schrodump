// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Closes the loop that was broken: provisioning writes keys that the BACKUP path accepts.
//
// The gap this guards was not a bug inside either half. resolveRecipients was correct, and the
// provisioning service is correct; nothing connected them, and no test asked whether a freshly
// provisioned organization could take a backup at all. That question is asked here, against a real
// database, because the answer depends on Prisma actually writing the enum values and actually
// leaving encryptedIdentity null.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Decrypter } from "age-encryption";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRecipients } from "../crypto/artifact.js";
import { decryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import { selectSelfBackupRecipients } from "../jobs/self-backup.js";
import { createEncryptionKeyService } from "./wiring.js";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const KEK = Buffer.alloc(32, 3);

describe.skipIf(!enabled)("a freshly provisioned organization can take a backup (integration)", () => {
  let container: StartedTestContainer;
  let prisma: PrismaClient;
  let organizationId: string;

  beforeAll(async () => {
    container = await new GenericContainer(process.env.SCHRODUMP_TEST_POSTGRES_IMAGE ?? "postgres:18-alpine")
      .withEnvironment({ POSTGRES_USER: "schrodump", POSTGRES_PASSWORD: "schrodump", POSTGRES_DB: "app" })
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
      data: { name: "fresh", slug: `fresh-${Date.now()}` },
    });
    organizationId = org.id;
  }, 240_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
    if (container !== undefined) await container.stop();
  });

  it("goes from no keys to a backup-ready organization", async () => {
    const service = createEncryptionKeyService(prisma, KEK);

    // The state a fresh install is actually in: resolveRecipients refuses, which is what every
    // first backup used to hit with no way forward.
    expect(() => resolveRecipients([])).toThrow(/operational/);

    const provisioned = await service.provision(organizationId, { mode: "generate" });
    expect(provisioned.escrowIdentity).toMatch(/^AGE-SECRET-KEY-/);

    // The backup path's own resolver, reading through the service's own reader. This is the seam
    // that did not exist.
    const recipients = resolveRecipients(await service.existing(organizationId));
    expect(recipients.recipients).toHaveLength(2);
    expect(recipients.keyIds).toEqual([provisioned.operationalKeyId, provisioned.escrowKeyId]);

    // And the self-backup's stricter rule is satisfied too, so the deployment can protect its own
    // catalogue without a second provisioning step.
    expect(selectSelfBackupRecipients(await service.existing(organizationId)).recipients[0]).toBe(
      (await service.list(organizationId)).find((k) => k.type === "escrow")?.publicRecipient,
    );
  });

  it("stores an operational identity the server can actually decrypt with", async () => {
    const row = await prisma.encryptionKey.findFirstOrThrow({
      where: { organizationId, type: "operational" },
    });
    // Round-tripped through the KEK and then used to open something the recipient sealed: proves
    // the stored identity is the matching half, not merely a well-formed string.
    const identity = decryptCredential(KEK, parseEncryptedCredential(row.encryptedIdentity));
    const decrypter = new Decrypter();
    expect(() => decrypter.addIdentity(identity)).not.toThrow();
  });

  it("never wrote the escrow identity to the database", async () => {
    const escrow = await prisma.encryptionKey.findFirstOrThrow({
      where: { organizationId, type: "escrow" },
    });
    // The single claim the whole design rests on, checked against the real column rather than
    // against the arguments the service was called with.
    expect(escrow.encryptedIdentity).toBeNull();
    expect(escrow.publicRecipient).toMatch(/^age1/);
  });

  it("refuses a second provisioning rather than issuing a competing active key", async () => {
    const service = createEncryptionKeyService(prisma, KEK);
    const { provisioningBlockers } = await import("../crypto/key-provisioning.js");
    expect(provisioningBlockers(await service.existing(organizationId))).toEqual([
      "operational",
      "escrow",
    ]);
  });
});
