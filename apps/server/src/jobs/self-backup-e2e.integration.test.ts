// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The self-backup, end to end, with nothing faked between the scheduler tick and the bucket.
//
// self-backup-recovery.integration.test.ts proves the crypto and pg_restore round trip from an
// in-process dump. This one proves the two halves that one deliberately left to the operator:
//
//   1. an EPHEMERAL EXECUTOR CONTAINER reaching the metadata database over a Docker network — the
//      failure that would otherwise have shipped, since the metadata database is unreachable from
//      the network the target executors run on;
//   2. the round trip through a real S3 bucket.
//
// It drives runScheduledSelfBackup itself: real Prisma, real KEK-wrapped destination secret, real
// runner, real upload. Then it recovers the object the way an operator would and asserts the
// catalog came back.
//
// Needs Docker AND an S3 endpoint (CI provides MinIO). What remains uncovered after this is the
// operator's own network topology, and nothing else.

import { execFile, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { createS3Driver } from "@schrodump/storage/s3";
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptStream, generateAgeKeyPair } from "../crypto/artifact.js";
import { encryptCredential } from "../crypto/envelope.js";
import { runScheduledSelfBackup } from "./self-backup-scheduler.js";

const s3Endpoint = process.env.SCHRODUMP_TEST_S3_ENDPOINT;
const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1" && s3Endpoint !== undefined;
const IMAGE = process.env.SCHRODUMP_TEST_POSTGRES_IMAGE ?? "postgres:18-alpine";
// The alias the EXECUTOR resolves. It is not localhost: the dump runs in its own container, so the
// host in DATABASE_URL has to be a name on the shared network. This is the exact distinction that
// made compose's `internal` network necessary in the first place.
const DB_ALIAS = "selfbackup-metadata-db";

async function startPostgres(network?: StartedNetwork): Promise<StartedTestContainer> {
  let container = new GenericContainer(IMAGE)
    .withEnvironment({ POSTGRES_USER: "schrodump", POSTGRES_PASSWORD: "schrodump", POSTGRES_DB: "app" })
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d app"],
      interval: 1000,
      timeout: 3000,
      retries: 30,
    })
    .withWaitStrategy(Wait.forHealthCheck());
  if (network !== undefined) container = container.withNetwork(network).withNetworkAliases(DB_ALIAS);
  return container.start();
}

function urlFor(container: StartedTestContainer): string {
  return `postgresql://schrodump:schrodump@${container.getHost()}:${container.getMappedPort(5432)}/app?schema=public`;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe.skipIf(!enabled)("self-backup end to end (integration)", () => {
  const kek = Buffer.alloc(32, 7);
  const marker = `e2e-${Date.now()}`;
  const prefix = `selfbackup-e2e/${marker}`;

  let network: StartedNetwork;
  let source: StartedTestContainer;
  let target: StartedTestContainer;
  let prisma: PrismaClient;
  let escrowIdentity: string;
  let destinationId: string;
  let driver: ReturnType<typeof createS3Driver>;
  // Captured by the first tick and read by the recovery tests, so those never silently inspect a
  // row some later test happened to produce. Undefined means the tick did not succeed, and the
  // recovery tests say so instead of passing on someone else's artifact.
  let selfBackupId: string | undefined;

  beforeAll(async () => {
    network = await new Network().start();
    [source, target] = await Promise.all([startPostgres(network), startPostgres()]);

    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: urlFor(source) },
    });
    prisma = new PrismaClient({ datasourceUrl: urlFor(source) });

    const org = await prisma.organization.create({ data: { name: marker, slug: marker } });
    const escrow = await generateAgeKeyPair();
    const operational = await generateAgeKeyPair();
    escrowIdentity = escrow.identity;
    await prisma.encryptionKey.createMany({
      data: [
        { organizationId: org.id, keyId: escrow.keyId, type: "escrow", publicRecipient: escrow.recipient, state: "active" },
        {
          organizationId: org.id,
          keyId: operational.keyId,
          type: "operational",
          publicRecipient: operational.recipient,
          state: "active",
          encryptedIdentity: encryptCredential(kek, operational.identity),
        },
      ],
    });

    const destination = await prisma.storageDestination.create({
      data: {
        organizationId: org.id,
        name: "e2e",
        endpoint: s3Endpoint ?? "",
        region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
        bucket: process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test",
        prefix,
        accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "minio",
        encryptedSecretAccessKey: encryptCredential(kek, process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? "minio123"),
        forcePathStyle: true,
      },
    });
    destinationId = destination.id;

    driver = createS3Driver({
      endpoint: s3Endpoint,
      region: destination.region,
      bucket: destination.bucket,
      prefix,
      accessKeyId: destination.accessKeyId,
      secretAccessKey: process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? "minio123",
      forcePathStyle: true,
    });
  }, 300_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
    await Promise.all([source?.stop(), target?.stop()]);
    await network?.stop();
  });

  it("runs the scheduled tick: executor reaches the metadata database and the object lands in the bucket", async () => {
    const log = { info: () => undefined, error: () => undefined };
    const ran = await runScheduledSelfBackup({
      prisma,
      kek,
      // The alias, not localhost — this is the assertion that the executor's own networking works.
      databaseUrl: `postgresql://schrodump:schrodump@${DB_ALIAS}:5432/app`,
      destinationId,
      network: network.getName(),
      intervalMs: 86_400_000,
      now: () => new Date(),
      log,
    });
    expect(ran).toBe(true);

    const row = await prisma.selfBackup.findFirst({ orderBy: { startedAt: "desc" } });
    selfBackupId = row?.id;
    // The reason is asserted before the state so a failure names itself instead of just saying
    // "expected FAILED to be SUCCEEDED".
    expect(row?.reason).toBeNull();
    expect(row?.state).toBe("SUCCEEDED");
    expect(row?.bucketKey).toContain("_self/");
    // The zero-byte guard would have deleted the object and failed the run; this is the positive
    // side of it — a metadata dump is never a few hundred bytes.
    expect(Number(row?.sizeBytes ?? 0)).toBeGreaterThan(1000);
  }, 300_000);

  it("is not due again inside the interval", async () => {
    const log = { info: () => undefined, error: () => undefined };
    expect(
      await runScheduledSelfBackup({
        prisma,
        kek,
        databaseUrl: `postgresql://schrodump:schrodump@${DB_ALIAS}:5432/app`,
        destinationId,
        network: network.getName(),
        intervalMs: 86_400_000,
        now: () => new Date(),
        log,
      }),
    ).toBe(false);
    expect(await prisma.selfBackup.count()).toBe(1);
  });

  it("recovers from the bucket with the escrow identity alone, and the catalog comes back", async () => {
    const id = selfBackupId;
    // Throws rather than expect(): a missing id means the first tick never produced a row, and this
    // test must say that instead of falling through to whichever row happens to be newest.
    if (id === undefined) throw new Error("the first tick produced no self-backup row");
    const row = await prisma.selfBackup.findFirstOrThrow({ where: { id } });

    const ciphertext = await collect(await driver.get(row.bucketKey ?? ""));
    const dump = await collect(
      (await decryptStream(Readable.from([ciphertext]), escrowIdentity)).pipe(createGunzip()),
    );

    const restore = execFile(
      "docker",
      [
        "exec", "-i", "-e", "PGPASSWORD=schrodump",
        target.getName().replace(/^\//, ""),
        "pg_restore", "-h", "127.0.0.1", "-U", "schrodump", "-d", "app", "--no-owner",
      ],
      { encoding: "buffer" },
    );
    await pipeline(Readable.from([dump]), restore.stdin!);
    await new Promise<void>((resolve, reject) => {
      restore.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_restore exited ${String(code)}`))));
    });

    const restored = new PrismaClient({ datasourceUrl: urlFor(target) });
    try {
      // The organization AND the self-backup row itself: the recovered catalog knows about the very
      // backup it was recovered from, which is what makes the bucket addressable again.
      expect((await restored.organization.findFirst({ where: { slug: marker } }))?.name).toBe(marker);
      expect(await restored.selfBackup.count()).toBe(1);
    } finally {
      await restored.$disconnect();
    }
  }, 180_000);

  it("leaves the sidecar in clear beside the artifact, naming the escrow requirement", async () => {
    const id = selfBackupId;
    // Throws rather than expect(): a missing id means the first tick never produced a row, and this
    // test must say that instead of falling through to whichever row happens to be newest.
    if (id === undefined) throw new Error("the first tick produced no self-backup row");
    const row = await prisma.selfBackup.findFirstOrThrow({ where: { id } });
    // Pinned before the fetch. Without it a FAILED run leaves manifestKey null, `?? ""` turns that
    // into a request for the prefix itself, and whatever comes back gets parsed — which is how this
    // test passed once against a run that had produced no sidecar at all.
    const key = row.manifestKey;
    expect(key).not.toBeNull();
    const sidecar = JSON.parse((await collect(await driver.get(key ?? ""))).toString("utf8")) as {
      recovery: string;
      bucketKey: string;
      checksum: string;
      checksumAlgorithm: string;
      encryption: { keyIds: string[] };
    };
    // Whoever reads this file is mid-disaster and will not have the docs open.
    expect(sidecar.recovery).toMatch(/escrow/i);
    expect(sidecar.encryption.keyIds.length).toBeGreaterThan(0);

    // These three are a CONTRACT with scripts/rehearse-recovery.sh, which reads them with
    // `jq -r '.bucketKey'` and `jq -r '.checksum'` to find the object and verify it before
    // decrypting. Renaming a field here would leave that script failing on the one day it is
    // used, and nothing else in the suite would notice.
    expect(sidecar.bucketKey).toBe(row.bucketKey);
    expect(sidecar.checksumAlgorithm).toBe("sha256");
    expect(sidecar.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
