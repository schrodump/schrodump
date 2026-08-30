// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// End-to-end smoke for FULL_RESTORE verify: real Docker (a throwaway origin postgres AND the
// ephemeral verify sandbox runFullRestore spins up) + a real S3-compatible endpoint (MinIO) +
// a real metadata Postgres — all self-provisioned via testcontainers, mirroring claim.test.ts and
// probe.integration.test.ts. Opt-in only: needs BOTH gates the sibling integration tests use
// individually (SCHRODUMP_TEST_INTEGRATION for Docker, SCHRODUMP_TEST_S3_* for S3), combined here
// because this smoke exercises the whole pipeline at once, never in the default unit run.
//
// The artifact is REAL, not a fixture file: it is produced by running the actual backup pipeline
// (createJobExecutor.runBackup) against a throwaway postgres target, then verified by running the
// actual verify pipeline (createJobExecutor.runVerify) — the same wiring production runs, not a
// re-implementation, so this proves the real FULL_RESTORE path: sandbox up, restore in, assert,
// sandbox down.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { PrismaClient } from "@prisma/client";
import { generateAgeKeyPair } from "../crypto/artifact.js";
import { encryptCredential } from "../crypto/envelope.js";
import type { Env } from "../env.js";
import { createJobExecutor } from "./worker-wiring.js";
import type { ClaimedJob } from "./worker.js";

const s3Endpoint = process.env.SCHRODUMP_TEST_S3_ENDPOINT;
const enabled =
  process.env.SCHRODUMP_TEST_INTEGRATION === "1" &&
  s3Endpoint !== undefined &&
  s3Endpoint.length > 0;

const ORIGIN_PASSWORD = "schrodump-it-origin-pw";
// docker.ts's executor network must already exist (RUNNER_NETWORK_MISSING otherwise) — "bridge" is
// Docker's own default network, always present, and already the pattern packages/runner's own
// docker.integration.test.ts uses for the same reason.
const EXECUTOR_NETWORK = "bridge";

// The origin's host:port is used for TWO different callers that this test cannot put on the same
// docker network: the RICH probe (backup-wiring runs it in-process, straight `pg` TCP from the test
// process) and the dump/restore executors (real containers on EXECUTOR_NETWORK). The address both
// can reach is the executor network's OWN gateway IP against the origin's HOST-PUBLISHED port —
// reachable from a container on that network (Docker always publishes to the daemon host, which the
// gateway IP fronts) and, on a real Docker host (this repo's CI: ubuntu-latest, native Docker, no
// Desktop VM boundary), reachable directly from the test process too, because the bridge's gateway
// IP is a real interface on that same host. (On Docker Desktop for Mac specifically, the daemon runs
// inside a VM the host cannot route into directly, so this specific leg — host process -> gateway IP
// — does not resolve locally; this is a Desktop-only limitation, not a CI one.)
function bridgeGatewayIp(): string {
  return execFileSync(
    "docker",
    ["network", "inspect", EXECUTOR_NETWORK, "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { encoding: "utf8" },
  ).trim();
}

// Snapshot of every container id on the host daemon (running or stopped) — used to prove the
// verify sandbox (and its restore/assertion helper containers) leave nothing behind. There is no
// name/label on these containers to filter by (docker.ts never sets one — see packages/runner/src
// /docker.ts's DockerodeEngine.start/startService), so a before/after id diff is the equivalent
// check: docker.ts always force-removes in a `finally`, so a clean run's diff is empty.
function listContainerIds(): string[] {
  return execFileSync("docker", ["ps", "-aq"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe.skipIf(!enabled)("FULL_RESTORE verify (integration smoke)", () => {
  let origin: StartedTestContainer;
  let metadata: StartedTestContainer;
  let prisma: PrismaClient;
  let scratchRoot: string;
  let orgId: string;
  let policyId: string;
  let kek: Buffer;
  let env: Env;

  beforeAll(async () => {
    // The throwaway origin, on the SAME network the executor containers use (EXECUTOR_NETWORK),
    // published to the host so the in-process probe can reach it too (see bridgeGatewayIp above).
    origin = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "schrodump",
        POSTGRES_PASSWORD: ORIGIN_PASSWORD,
        POSTGRES_DB: "postgres",
      })
      .withNetworkMode(EXECUTOR_NETWORK)
      .withExposedPorts(5432)
      // Wait.forListeningPorts() is satisfied by the postgres image's TEMPORARY socket-only server,
      // which the entrypoint runs during initialisation before stopping it and starting the real one.
      // Connecting against that window fails with "the database system is starting up" — a flake that
      // reads as a code failure and trains everyone to re-run a red CI. `-h` forces pg_isready onto
      // TCP, which only the real server listens on: the same lesson already documented for the verify
      // sandbox in packages/engines/src/adapters/postgres.ts.
      .withHealthCheck({
        test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d postgres"],
        interval: 1000,
        timeout: 3000,
        retries: 30,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();

    // A real user table so the FULL_RESTORE assertion (count of restored user tables) has
    // something to count. Seeded via docker exec — local unix-socket trust auth, no TCP/password
    // needed for this one-off DDL.
    const seed = await origin.exec([
      "psql",
      "-U",
      "schrodump",
      "-d",
      "postgres",
      "-c",
      "CREATE TABLE smoke_check (id int primary key); INSERT INTO smoke_check VALUES (1);",
    ]);
    if (seed.exitCode !== 0) {
      throw new Error(`failed to seed the origin database: ${seed.output}`);
    }

    // The metadata Postgres (Prisma's own DB) is self-provisioned and migrated with the real
    // committed schema, exactly like claim.test.ts — the integration job gives Docker but no
    // ambient DATABASE_URL.
    metadata = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "schrodump",
        POSTGRES_PASSWORD: "schrodump",
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      // Wait.forListeningPorts() is satisfied by the postgres image's TEMPORARY socket-only server,
      // which the entrypoint runs during initialisation before stopping it and starting the real one.
      // Connecting against that window fails with "the database system is starting up" — a flake that
      // reads as a code failure and trains everyone to re-run a red CI. `-h` forces pg_isready onto
      // TCP, which only the real server listens on: the same lesson already documented for the verify
      // sandbox in packages/engines/src/adapters/postgres.ts.
      .withHealthCheck({
        test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d app"],
        interval: 1000,
        timeout: 3000,
        retries: 30,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    const metadataUrl = `postgresql://schrodump:schrodump@${metadata.getHost()}:${metadata.getMappedPort(5432)}/app?schema=public`;
    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: metadataUrl },
    });
    prisma = new PrismaClient({ datasourceUrl: metadataUrl });

    scratchRoot = await mkdtemp(join(tmpdir(), "schrodump-verify-it-"));
    kek = randomBytes(32);

    const org = await prisma.organization.create({
      data: { name: "verify-it", slug: `verify-it-${Date.now()}` },
    });
    orgId = org.id;

    const target = await prisma.databaseTarget.create({
      data: {
        organizationId: orgId,
        name: "origin",
        engine: "postgres",
        host: bridgeGatewayIp(),
        port: origin.getMappedPort(5432),
        username: "schrodump",
        encryptedCredential: encryptCredential(kek, ORIGIN_PASSWORD),
        tls: false,
        scope: { databases: [] },
      },
    });

    const destination = await prisma.storageDestination.create({
      data: {
        organizationId: orgId,
        name: "minio",
        endpoint: s3Endpoint ?? null,
        region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
        bucket: process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test",
        prefix: `it/full-restore-verify/${randomUUID()}`,
        accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "",
        encryptedSecretAccessKey: encryptCredential(
          kek,
          process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? "",
        ),
        forcePathStyle: true,
        sealMode: "operational",
      },
    });

    // Both an active operational AND an active escrow key are required — resolveRecipients (the
    // real backup path) throws without both.
    const operational = await generateAgeKeyPair();
    const escrow = await generateAgeKeyPair();
    await prisma.encryptionKey.create({
      data: {
        organizationId: orgId,
        keyId: operational.keyId,
        type: "operational",
        publicRecipient: operational.recipient,
        encryptedIdentity: encryptCredential(kek, operational.identity),
        state: "active",
      },
    });
    await prisma.encryptionKey.create({
      data: {
        organizationId: orgId,
        keyId: escrow.keyId,
        type: "escrow",
        publicRecipient: escrow.recipient,
        state: "active",
      },
    });

    const policy = await prisma.backupPolicy.create({
      data: {
        organizationId: orgId,
        name: "verify-it",
        targetId: target.id,
        destinationId: destination.id,
        cron: "0 3 * * *",
        verifyLevel: "FULL_RESTORE",
        executionMode: "STREAM",
        parallelism: 1,
      },
    });
    policyId = policy.id;

    env = {
      DATABASE_URL: metadataUrl,
      SCHRODUMP_KEK: kek.toString("base64"),
      SCHRODUMP_URL: "http://localhost:8080",
      PORT: 8080,
      LOG_LEVEL: "error",
      SCHRODUMP_SCRATCH_PATH: scratchRoot,
      SCHRODUMP_SCRATCH_MAX_BYTES: 107_374_182_400,
      SCHRODUMP_MAX_CONCURRENT_STAGED: 2,
      SCHRODUMP_EXECUTOR_NETWORK: EXECUTOR_NETWORK,
      WORKER_POLL_MS: 2000,
      SCHRODUMP_SCHEDULER_TICK_MS: 30000,
      SCHRODUMP_SHUTDOWN_GRACE_MS: 8000,
    };
  }, 300_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
    if (metadata !== undefined) await metadata.stop();
    if (origin !== undefined) await origin.stop();
    if (scratchRoot !== undefined) await rm(scratchRoot, { recursive: true, force: true });
  });

  // Runs the REAL backup pipeline (createJobExecutor.runBackup) against the throwaway origin,
  // producing a genuine gzip+age-encrypted postgres artifact in MinIO. Returns its id.
  async function seedArtifact(): Promise<string> {
    const executor = createJobExecutor({ prisma, kek, env });
    const job = await prisma.backupJob.create({
      data: {
        organizationId: orgId,
        policyId,
        kind: "BACKUP",
        state: "PENDING",
        correlationId: `it-backup-${randomUUID()}`,
      },
    });
    const claimed: ClaimedJob = {
      id: job.id,
      organizationId: orgId,
      kind: "BACKUP",
      policyId,
      artifactId: null,
      correlationId: job.correlationId,
      restoreParams: null,
    };
    const result = await executor.runBackup(claimed);
    if (!result.ok || result.artifactId === null) {
      const row = await prisma.backupJob.findUniqueOrThrow({ where: { id: job.id } });
      throw new Error(
        `backup fixture did not produce an artifact: ${row.reason ?? "unknown reason"}`,
      );
    }
    return result.artifactId;
  }

  // Runs the REAL verify pipeline (createJobExecutor.runVerify) against a seeded artifact. Returns
  // the VERIFY job's id so the caller can assert its terminal state/reason.
  async function verifyArtifact(artifactId: string): Promise<string> {
    const executor = createJobExecutor({ prisma, kek, env });
    const job = await prisma.backupJob.create({
      data: {
        organizationId: orgId,
        kind: "VERIFY",
        state: "PENDING",
        correlationId: `it-verify-${randomUUID()}`,
        artifactId,
      },
    });
    const claimed: ClaimedJob = {
      id: job.id,
      organizationId: orgId,
      kind: "VERIFY",
      policyId: null,
      artifactId,
      correlationId: job.correlationId,
      restoreParams: null,
    };
    await executor.runVerify(claimed);
    return job.id;
  }

  it("restores a real postgres artifact into an ephemeral sandbox, verifies it, and leaves no container behind", async () => {
    const artifactId = await seedArtifact();

    const before = new Set(listContainerIds());
    const verifyJobId = await verifyArtifact(artifactId);
    const leaked = listContainerIds().filter((id) => !before.has(id));
    expect(leaked).toEqual([]);

    const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(artifact.state).toBe("VERIFIED");

    const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
    expect(job.state).toBe("SUCCEEDED");
  }, 300_000);

  it("an unresolvable sandbox image leaves verify INCONCLUSIVE and the artifact UNOBSERVED", async () => {
    const artifactId = await seedArtifact();
    // postgresAdapter.imageFor (packages/engines/src/adapters/postgres.ts) is the ONLY place a
    // postgres sandbox image tag comes from, and it is deterministic over the supported major
    // range (13-18) — there is no way through the public adapter contract to hand it a bogus
    // *existing* tag. An out-of-range major is the one way to reach the SAME failure this guards
    // against (no valid image can be resolved) without a network-dependent, flaky "pull a made-up
    // tag" step: imageFor throws EngineDescriptorError before any container starts, worker-wiring's
    // total catch (runFullRestore) catches it, and classifyVerifyError maps it to INCONCLUSIVE —
    // identically to how a real bad-tag docker pull failure (RUNNER_FAILED) would classify.
    await prisma.artifact.update({ where: { id: artifactId }, data: { serverVersionNum: 190000 } });

    const verifyJobId = await verifyArtifact(artifactId);

    const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(artifact.state).toBe("UNOBSERVED");

    const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
    expect(job.state).toBe("FAILED");
    expect(job.reason).toMatch(/inconclusive/i);
  }, 180_000);
});
