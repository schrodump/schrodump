// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { claimNextJob } from "./claim.js";

const RUN = process.env.SCHRODUMP_TEST_INTEGRATION === "1";

describe.skipIf(!RUN)("claimNextJob (integration)", () => {
  const prisma = new PrismaClient();
  let orgId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: "claim-test", slug: `claim-test-${Date.now()}` } });
    orgId = org.id;
  });
  afterAll(async () => {
    await prisma.backupJob.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
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
