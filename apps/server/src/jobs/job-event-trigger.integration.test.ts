// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The outbox trigger, against a real PostgreSQL running the real migrations.
//
// This suite exists for one case that no unit test can reach: `claimNextJob` flips PENDING ->
// RUNNING in raw SQL, because the claim has to be atomic against concurrent workers. A Prisma
// client extension — the mechanism data/scope.ts uses for organizationId — never sees that
// statement, so an application-side writer would miss the most common transition in the system.
// Proving the trigger catches it is the whole reason the trigger is in the database.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "./claim.js";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";

describe.skipIf(!enabled)("the JobEvent trigger (integration)", () => {
  let container: StartedTestContainer;
  let prisma: PrismaClient;
  let organizationId: string;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "schrodump",
        POSTGRES_PASSWORD: "schrodump",
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      // -h forces pg_isready onto TCP: the image's init phase runs a socket-only server first, and
      // waiting on the port alone connects during that window.
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
      data: { name: "trigger", slug: `trigger-${Date.now()}` },
    });
    organizationId = org.id;
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it("records the raw-SQL claim, which no application hook can see", async () => {
    const job = await prisma.backupJob.create({
      data: { organizationId, kind: "BACKUP", state: "PENDING", correlationId: "claim-case" },
    });
    const claimed = await claimNextJob(prisma);
    expect(claimed?.id).toBe(job.id);

    const events = await prisma.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { at: "asc" },
    });
    expect(events.map((e) => e.state)).toEqual(["PENDING", "RUNNING"]);
    expect(events[0]?.organizationId).toBe(organizationId);
    expect(events[0]?.kind).toBe("BACKUP");
  });

  it("records an ordinary state change through Prisma too", async () => {
    const job = await prisma.backupJob.create({
      data: { organizationId, kind: "VERIFY", state: "PENDING", correlationId: "update-case" },
    });
    await prisma.backupJob.update({ where: { id: job.id }, data: { state: "SUCCEEDED" } });

    const events = await prisma.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { at: "asc" },
    });
    expect(events.map((e) => e.state)).toEqual(["PENDING", "SUCCEEDED"]);
  });

  it("does not fire when a column other than state changes", async () => {
    // `UPDATE OF state` still fires when the column is written with the value it already holds, so
    // the function compares. Otherwise an unrelated write would spend a delivery announcing nothing.
    const job = await prisma.backupJob.create({
      data: { organizationId, kind: "BACKUP", state: "PENDING", correlationId: "noop-case" },
    });
    await prisma.backupJob.update({ where: { id: job.id }, data: { reason: "noted" } });
    await prisma.backupJob.update({ where: { id: job.id }, data: { state: "PENDING" } });

    expect(await prisma.jobEvent.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("takes the event with the job's organization when the organization is deleted", async () => {
    // The row is FK'd with ON DELETE CASCADE like every other org-scoped table; an outbox that
    // outlived its tenant would be undeliverable and unreadable both.
    const org = await prisma.organization.create({
      data: { name: "doomed", slug: `doomed-${Date.now()}` },
    });
    await prisma.backupJob.create({
      data: {
        organizationId: org.id,
        kind: "BACKUP",
        state: "PENDING",
        correlationId: "cascade-case",
      },
    });
    expect(await prisma.jobEvent.count({ where: { organizationId: org.id } })).toBe(1);

    await prisma.organization.delete({ where: { id: org.id } });
    expect(await prisma.jobEvent.count({ where: { organizationId: org.id } })).toBe(0);
  });
});
