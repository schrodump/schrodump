// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// End-to-end smoke for FULL_RESTORE verify on mysql and mongodb — the sibling of
// full-restore-verify.integration.test.ts (the postgres smoke), same gating + setup style, split
// into two fully self-contained describe blocks (each provisions its own metadata Postgres, org,
// destination and origin container) rather than sharing state across engines. This is the FIRST
// end-to-end exercise of the mongo dump path: mongo backup was unwired until the `--config` mount
// landed (see the mongo-config commits), so nothing had ever run mongodump for real before this.
//
// Every artifact here is REAL: produced by the actual backup pipeline (createJobExecutor.runBackup)
// against a throwaway origin, then judged by the actual verify pipeline (createJobExecutor.runVerify)
// — the same wiring production runs, not a re-implementation.
//
// mongo MUST use a SCOPED target (a single named database): resolveVerifyPlan downgrades an
// UNSCOPED mongo artifact's FULL_RESTORE to CHECKSUM (see worker-wiring.ts), which would silently
// skip the sandbox instead of exercising it. Both origins connect through a database-SCOPED
// credential, not root/superuser — required for mysql too: the RICH probe's `scope.databases`
// (packages/engines/src/probe/{mysql,mongodb}.ts) reports every database the credential can see,
// unfiltered by the target's configured scope (worker-wiring passes `probe.scope` straight into
// buildDump), so a root credential would report every system database alongside the real one. For
// mongo that means admin/config/local always ride along — mongodump refuses more than one scoped
// db (MONGODB_SCOPE_TOO_BROAD). Least-privilege credentials are the only way a scoped dump ever
// sees just the one intended database, independent of whatever the target's own Prisma scope says.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { PrismaClient } from "@prisma/client";
import { generateAgeKeyPair } from "../crypto/artifact.js";
import { encryptCredential } from "../crypto/envelope.js";
import type { Env } from "../env.js";
import { driverForDestination } from "./destination-driver.js";
import { createJobExecutor } from "./worker-wiring.js";
import type { ClaimedJob } from "./worker.js";

const s3Endpoint = process.env.SCHRODUMP_TEST_S3_ENDPOINT;
const enabled =
  process.env.SCHRODUMP_TEST_INTEGRATION === "1" && s3Endpoint !== undefined && s3Endpoint.length > 0;

// docker.ts's executor network must already exist (RUNNER_NETWORK_MISSING otherwise) — "bridge" is
// Docker's own default network, always present. Mirrors full-restore-verify.integration.test.ts.
const EXECUTOR_NETWORK = "bridge";

// The origin's host:port is reached by TWO different callers this test cannot put on the same
// docker network: the RICH probe (backup-wiring runs it in-process, straight TCP from the test
// process) and the dump/restore executors (real containers on EXECUTOR_NETWORK). The bridge
// gateway IP against the origin's host-published port is reachable from both on a real Docker
// host (this repo's CI: ubuntu-latest, native Docker); on Docker Desktop for Mac the daemon runs
// inside a VM the host cannot route into directly, so the host-process leg does not resolve
// locally — see full-restore-verify.integration.test.ts's own note, which applies identically here.
function bridgeGatewayIp(): string {
  return execFileSync(
    "docker",
    ["network", "inspect", EXECUTOR_NETWORK, "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { encoding: "utf8" },
  ).trim();
}

// Snapshot of every container id on the host daemon — proves the verify sandbox (and its
// restore/assertion helpers) leave nothing behind. Mirrors full-restore-verify.integration.test.ts.
function listContainerIds(): string[] {
  return execFileSync("docker", ["ps", "-aq"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Overwrites the artifact's stored object with bytes that are not a valid age archive, so the
// restore pipeline's decrypt step (the FIRST stage, upstream of any engine-specific restore
// command) rejects it with RESTORE_DECRYPT_FAILED — classifyVerifyError maps that to FAILED. This
// is engine-agnostic: it exercises the same "the artifact itself is bad" path for mysql and mongo
// without needing an engine-specific corruption.
async function corruptArtifact(
  prisma: PrismaClient,
  kek: Buffer,
  organizationId: string,
  destinationId: string,
  bucketKey: string,
): Promise<void> {
  const destination = await driverForDestination(prisma, kek, organizationId, destinationId);
  if (destination === null) throw new Error("test setup: destination unavailable for corruption");
  await destination.driver.put(bucketKey, Readable.from([Buffer.from("not an age archive")]), {
    contentType: "application/octet-stream",
    partSize: 5 * 1024 * 1024,
    metadata: {},
  });
}

describe.skipIf(!enabled)("mysql FULL_RESTORE verify (integration smoke)", () => {
  let origin: StartedTestContainer;
  let metadata: StartedTestContainer;
  let prisma: PrismaClient;
  let scratchRoot: string;
  let orgId: string;
  let policyId: string;
  let destinationId: string;
  let kek: Buffer;
  let env: Env;

  // Only the scoped backup user's password ever becomes the target's stored credential; the root
  // password exists solely to seed the origin and healthcheck it (docker exec, never asserted).
  const MYSQL_ROOT_PASSWORD = "schrodump-it-mysql-root";
  const ORIGIN_PASSWORD = "schrodump-it-mysql-origin-pw";
  const SMOKE_DB = "schrodump_smoke";

  beforeAll(async () => {
    // MYSQL_DATABASE + MYSQL_USER/PASSWORD pre-creates the smoke db and a user granted ONLY on it
    // (host '%', so it accepts the executor-network connection) — the least-privilege credential
    // required so the RICH probe reports just this one database (see the file header).
    origin = await new GenericContainer("mysql:8")
      .withEnvironment({
        MYSQL_ROOT_PASSWORD,
        MYSQL_DATABASE: SMOKE_DB,
        MYSQL_USER: "schrodump",
        MYSQL_PASSWORD: ORIGIN_PASSWORD,
      })
      .withNetworkMode(EXECUTOR_NETWORK)
      .withExposedPorts(3306)
      // Wait.forListeningPorts() is satisfied by mysql's TEMPORARY bootstrap server (socket-only
      // init phase logs "ready for connections" twice); forcing TCP against 127.0.0.1 only the
      // FINAL server binds — same fix probe.integration.test.ts already uses for the same race.
      .withHealthCheck({
        test: ["CMD-SHELL", `mysqladmin ping -h 127.0.0.1 -uroot -p${MYSQL_ROOT_PASSWORD} --silent`],
        interval: 2000,
        timeout: 5000,
        retries: 30,
        startPeriod: 5000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();

    const seed = await origin.exec([
      "mysql",
      "-uschrodump",
      `-p${ORIGIN_PASSWORD}`,
      "-e",
      `CREATE TABLE ${SMOKE_DB}.smoke_check (id INT PRIMARY KEY); INSERT INTO ${SMOKE_DB}.smoke_check VALUES (1);`,
    ]);
    if (seed.exitCode !== 0) {
      throw new Error(`failed to seed the mysql origin: ${seed.output}`);
    }

    metadata = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_USER: "schrodump", POSTGRES_PASSWORD: "schrodump", POSTGRES_DB: "app" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const metadataUrl = `postgresql://schrodump:schrodump@${metadata.getHost()}:${metadata.getMappedPort(5432)}/app?schema=public`;
    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: metadataUrl },
    });
    prisma = new PrismaClient({ datasourceUrl: metadataUrl });

    scratchRoot = await mkdtemp(join(tmpdir(), "schrodump-mysql-verify-it-"));
    kek = randomBytes(32);

    const org = await prisma.organization.create({
      data: { name: "mysql-verify-it", slug: `mysql-verify-it-${Date.now()}` },
    });
    orgId = org.id;

    const target = await prisma.databaseTarget.create({
      data: {
        organizationId: orgId,
        name: "origin",
        engine: "mysql",
        host: bridgeGatewayIp(),
        port: origin.getMappedPort(3306),
        username: "schrodump",
        encryptedCredential: encryptCredential(kek, ORIGIN_PASSWORD),
        tls: false,
        scope: { databases: [SMOKE_DB] },
      },
    });

    const destination = await prisma.storageDestination.create({
      data: {
        organizationId: orgId,
        name: "minio",
        endpoint: s3Endpoint ?? null,
        region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
        bucket: process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test",
        prefix: `it/mysql-full-restore-verify/${randomUUID()}`,
        accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "",
        encryptedSecretAccessKey: encryptCredential(kek, process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? ""),
        forcePathStyle: true,
        sealMode: "operational",
      },
    });
    destinationId = destination.id;

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
        name: "mysql-verify-it",
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
    };
  }, 300_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
    if (metadata !== undefined) await metadata.stop();
    if (origin !== undefined) await origin.stop();
    if (scratchRoot !== undefined) await rm(scratchRoot, { recursive: true, force: true });
  });

  async function seedArtifact(): Promise<string> {
    const executor = createJobExecutor({ prisma, kek, env });
    const job = await prisma.backupJob.create({
      data: {
        organizationId: orgId,
        policyId,
        kind: "BACKUP",
        state: "PENDING",
        correlationId: `it-mysql-backup-${randomUUID()}`,
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
      throw new Error(`mysql backup fixture did not produce an artifact: ${row.reason ?? "unknown reason"}`);
    }
    return result.artifactId;
  }

  async function verifyArtifact(artifactId: string): Promise<string> {
    const executor = createJobExecutor({ prisma, kek, env });
    const job = await prisma.backupJob.create({
      data: {
        organizationId: orgId,
        kind: "VERIFY",
        state: "PENDING",
        correlationId: `it-mysql-verify-${randomUUID()}`,
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

  it(
    "restores a real mysql artifact into an ephemeral sandbox, verifies it, and leaves no container behind",
    async () => {
      const artifactId = await seedArtifact();

      const before = new Set(listContainerIds());
      const verifyJobId = await verifyArtifact(artifactId);
      const leaked = listContainerIds().filter((id) => !before.has(id));
      expect(leaked).toEqual([]);

      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(artifact.state).toBe("VERIFIED");

      const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
      expect(job.state).toBe("SUCCEEDED");
    },
    300_000,
  );

  it(
    "a corrupted artifact leaves verify FAILED",
    async () => {
      const artifactId = await seedArtifact();
      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      await corruptArtifact(prisma, kek, orgId, destinationId, artifact.bucketKey);

      const verifyJobId = await verifyArtifact(artifactId);

      const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(updated.state).toBe("FAILED");

      const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
      expect(job.state).toBe("FAILED");
    },
    300_000,
  );

  it(
    "an unresolvable sandbox image leaves verify INCONCLUSIVE and the artifact UNOBSERVED",
    async () => {
      const artifactId = await seedArtifact();
      // Unlike postgres, mysqlAdapter.imageFor (packages/engines/src/adapters/mysql.ts) never
      // validates a supported range — it always computes `mysql:<major>.<minor>` from
      // serverVersionNum. A large-enough version therefore resolves to a tag that does not exist
      // on the registry (mysql:99.99); the pull fails inside withEphemeralService, which the outer
      // catch in worker-wiring.ts's runFullRestore funnels through classifyVerifyError exactly
      // like any other our-infra failure — INCONCLUSIVE, never FAILED.
      await prisma.artifact.update({ where: { id: artifactId }, data: { serverVersionNum: 999_999 } });

      const verifyJobId = await verifyArtifact(artifactId);

      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(artifact.state).toBe("UNOBSERVED");

      const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
      expect(job.state).toBe("FAILED");
      expect(job.reason).toMatch(/inconclusive/i);
    },
    180_000,
  );
});

describe.skipIf(!enabled)("mongodb FULL_RESTORE verify (integration smoke)", () => {
  let origin: StartedTestContainer;
  let metadata: StartedTestContainer;
  let prisma: PrismaClient;
  let scratchRoot: string;
  let orgId: string;
  let policyId: string;
  let destinationId: string;
  let kek: Buffer;
  let env: Env;

  // The bootstrap root exists only to seed the origin (docker exec, never asserted, never stored).
  // The target's stored credential is a database-SCOPED user created below — required so the RICH
  // probe's listDatabases() reports only the smoke db (see the file header): a root credential
  // would see admin/config/local alongside it and mongodump would refuse the scope as too broad.
  const MONGO_ROOT_PASSWORD = "schrodump-it-mongo-root";
  const ORIGIN_PASSWORD = "schrodump-it-mongo-origin-pw";
  const SMOKE_DB = "schrodump_smoke";

  beforeAll(async () => {
    origin = await new GenericContainer("mongo:8")
      .withEnvironment({
        MONGO_INITDB_ROOT_USERNAME: "root",
        MONGO_INITDB_ROOT_PASSWORD: MONGO_ROOT_PASSWORD,
      })
      .withNetworkMode(EXECUTOR_NETWORK)
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    // Wait.forListeningPorts() is satisfied by mongo's TEMPORARY bootstrap mongod (which also
    // binds TCP, with --auth stripped, before the real auth-enforcing server replaces it — the
    // same race documented in mongodb.ts's buildVerifySandbox). An authenticated ping, retried,
    // only succeeds once the REAL server — with the root user actually created — is up; this
    // guards the seed step below from racing that transition.
    for (let attempt = 0; ; attempt += 1) {
      const ping = await origin.exec([
        "mongosh",
        "-u",
        "root",
        "-p",
        MONGO_ROOT_PASSWORD,
        "--authenticationDatabase",
        "admin",
        "--quiet",
        "--eval",
        "db.runCommand({ping:1}).ok",
      ]);
      if (ping.exitCode === 0) break;
      if (attempt >= 29) {
        throw new Error(`mongo origin never became ready for authenticated access: ${ping.output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Seeds a real collection AND creates the least-privilege backup user in one shot: readWrite
    // scoped to SMOKE_DB only, created in `admin` (mongoConnArgs always authenticates against
    // `connection.database`, which probeDatabaseFor collapses to "admin" for mongo).
    const seed = await origin.exec([
      "mongosh",
      "-u",
      "root",
      "-p",
      MONGO_ROOT_PASSWORD,
      "--authenticationDatabase",
      "admin",
      "--quiet",
      "--eval",
      `db.getSiblingDB("${SMOKE_DB}").smoke_check.insertOne({_id: 1, hello: "world"}); ` +
        `db.getSiblingDB("admin").createUser({user: "schrodump", pwd: "${ORIGIN_PASSWORD}", ` +
        `roles: [{role: "readWrite", db: "${SMOKE_DB}"}]});`,
    ]);
    if (seed.exitCode !== 0) {
      throw new Error(`failed to seed the mongo origin: ${seed.output}`);
    }

    metadata = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_USER: "schrodump", POSTGRES_PASSWORD: "schrodump", POSTGRES_DB: "app" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const metadataUrl = `postgresql://schrodump:schrodump@${metadata.getHost()}:${metadata.getMappedPort(5432)}/app?schema=public`;
    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: metadataUrl },
    });
    prisma = new PrismaClient({ datasourceUrl: metadataUrl });

    scratchRoot = await mkdtemp(join(tmpdir(), "schrodump-mongo-verify-it-"));
    kek = randomBytes(32);

    const org = await prisma.organization.create({
      data: { name: "mongo-verify-it", slug: `mongo-verify-it-${Date.now()}` },
    });
    orgId = org.id;

    // SCOPED target — see the file header: an unscoped mongo artifact downgrades FULL_RESTORE to
    // CHECKSUM (resolveVerifyPlan in worker-wiring.ts) and would never exercise the sandbox here.
    const target = await prisma.databaseTarget.create({
      data: {
        organizationId: orgId,
        name: "origin",
        engine: "mongodb",
        host: bridgeGatewayIp(),
        port: origin.getMappedPort(27017),
        username: "schrodump",
        encryptedCredential: encryptCredential(kek, ORIGIN_PASSWORD),
        tls: false,
        scope: { databases: [SMOKE_DB] },
      },
    });

    const destination = await prisma.storageDestination.create({
      data: {
        organizationId: orgId,
        name: "minio",
        endpoint: s3Endpoint ?? null,
        region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
        bucket: process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test",
        prefix: `it/mongo-full-restore-verify/${randomUUID()}`,
        accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "",
        encryptedSecretAccessKey: encryptCredential(kek, process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? ""),
        forcePathStyle: true,
        sealMode: "operational",
      },
    });
    destinationId = destination.id;

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
        name: "mongo-verify-it",
        targetId: target.id,
        destinationId: destination.id,
        cron: "0 3 * * *",
        verifyLevel: "FULL_RESTORE",
        executionMode: "STREAM",
        parallelism: 1,
      },
    });
    policyId = policy.id;

    // mongo backup requires scratch (the `--config` credential file mount) — see
    // worker-wiring.ts's MONGO_CONFIG_SCRATCH_REQUIRED_REASON; scratchRoot above already covers it.
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
    };
  }, 300_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
    if (metadata !== undefined) await metadata.stop();
    if (origin !== undefined) await origin.stop();
    if (scratchRoot !== undefined) await rm(scratchRoot, { recursive: true, force: true });
  });

  async function seedArtifact(): Promise<string> {
    const executor = createJobExecutor({ prisma, kek, env });
    const job = await prisma.backupJob.create({
      data: {
        organizationId: orgId,
        policyId,
        kind: "BACKUP",
        state: "PENDING",
        correlationId: `it-mongo-backup-${randomUUID()}`,
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
      throw new Error(`mongo backup fixture did not produce an artifact: ${row.reason ?? "unknown reason"}`);
    }
    return result.artifactId;
  }

  async function verifyArtifact(artifactId: string): Promise<string> {
    const executor = createJobExecutor({ prisma, kek, env });
    const job = await prisma.backupJob.create({
      data: {
        organizationId: orgId,
        kind: "VERIFY",
        state: "PENDING",
        correlationId: `it-mongo-verify-${randomUUID()}`,
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

  it(
    "restores a real mongo artifact into an ephemeral sandbox, verifies it, and leaves no container behind",
    async () => {
      const artifactId = await seedArtifact();

      const before = new Set(listContainerIds());
      const verifyJobId = await verifyArtifact(artifactId);
      const leaked = listContainerIds().filter((id) => !before.has(id));
      expect(leaked).toEqual([]);

      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(artifact.state).toBe("VERIFIED");

      const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
      expect(job.state).toBe("SUCCEEDED");
    },
    300_000,
  );

  it(
    "a corrupted artifact leaves verify FAILED",
    async () => {
      const artifactId = await seedArtifact();
      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      await corruptArtifact(prisma, kek, orgId, destinationId, artifact.bucketKey);

      const verifyJobId = await verifyArtifact(artifactId);

      const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(updated.state).toBe("FAILED");

      const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
      expect(job.state).toBe("FAILED");
    },
    300_000,
  );

  it(
    "an unresolvable sandbox image leaves verify INCONCLUSIVE and the artifact UNOBSERVED",
    async () => {
      const artifactId = await seedArtifact();
      // mongodbAdapter.imageFor (packages/engines/src/adapters/mongodb.ts) always computes
      // `mongo:<major>` with no supported-range check — a large-enough version resolves to a tag
      // that does not exist (mongo:99), whose pull fails inside withEphemeralService exactly like
      // the mysql case above: classifyVerifyError funnels it to INCONCLUSIVE, never FAILED.
      await prisma.artifact.update({ where: { id: artifactId }, data: { serverVersionNum: 999_999 } });

      const verifyJobId = await verifyArtifact(artifactId);

      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(artifact.state).toBe("UNOBSERVED");

      const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: verifyJobId } });
      expect(job.state).toBe("FAILED");
      expect(job.reason).toMatch(/inconclusive/i);
    },
    180_000,
  );
});
