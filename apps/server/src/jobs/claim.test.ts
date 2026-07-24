// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { PrismaClient } from "@prisma/client";
import { claimNextJob } from "./claim.js";

// Opt-in only: needs Docker. Skipped unless SCHRODUMP_TEST_INTEGRATION=1. The metadata Postgres is
// self-provisioned via testcontainers (like probe.integration.test.ts) — the CI integration job
// gives us Docker but no ambient DATABASE_URL, so the test must stand up and migrate its own DB.
const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";

describe.skipIf(!enabled)("claimNextJob (integration)", () => {
  let container: StartedTestContainer;
  let prisma: PrismaClient;
  let orgId: string;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_USER: "schrodump", POSTGRES_PASSWORD: "schrodump", POSTGRES_DB: "app" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const url = `postgresql://schrodump:schrodump@${container.getHost()}:${container.getMappedPort(5432)}/app?schema=public`;

    // Apply the real schema (the committed migrations) to the throwaway DB.
    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: url },
    });

    prisma = new PrismaClient({ datasourceUrl: url });
    const org = await prisma.organization.create({ data: { name: "claim-test", slug: `claim-test-${Date.now()}` } });
    orgId = org.id;
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
    if (container !== undefined) await container.stop();
  });

  beforeEach(async () => {
    await prisma.backupJob.deleteMany({ where: { organizationId: orgId } });
  });

  it("returns null when there is no pending job", async () => {
    expect(await claimNextJob(prisma)).toBeNull();
  });

  it("claims a pending job, flips it to RUNNING, and never hands the same row twice", async () => {
    await prisma.backupJob.create({ data: { organizationId: orgId, kind: "BACKUP", state: "PENDING", correlationId: "c1" } });
    await prisma.backupJob.create({ data: { organizationId: orgId, kind: "BACKUP", state: "PENDING", correlationId: "c2" } });

    const [a, b, c] = await Promise.all([claimNextJob(prisma), claimNextJob(prisma), claimNextJob(prisma)]);
    const claimed = [a, b, c].filter((j): j is NonNullable<typeof j> => j !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((j) => j.id)).size).toBe(2); // no double-claim
    for (const j of claimed) {
      const row = await prisma.backupJob.findUnique({ where: { id: j.id } });
      expect(row?.state).toBe("RUNNING");
    }
  });
});
