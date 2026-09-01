// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The self-backup recovery drill, run for real.
//
// Everything else about self-backup is UNOBSERVED by construction: the job writes an object and
// nobody opens it. This is the test that opens it. It takes a real pg_dump of a real Schrodump
// schema, seals it with the production encrypt pipeline to an ESCROW-ONLY recipient set, then
// recovers it the way an operator would on the worst day — decrypt with the offline escrow
// identity, gunzip, pg_restore into an empty database — and asserts the catalog came back.
//
// It also asserts the claim the whole design rests on: an artifact sealed to escrow CANNOT be
// opened by the operational identity, because in the disaster this exists for that identity is
// inside the database that is gone.
//
// Opt-in: needs Docker. The dump command is not hand-written — it is the descriptor the production
// postgres adapter builds, executed inside the container, so the drill tests the real command.

import { execFile, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { resolveAdapter } from "@schrodump/engines/registry";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptStream, encryptStream, generateAgeKeyPair } from "../crypto/artifact.js";
import { selectSelfBackupRecipients } from "./self-backup.js";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const IMAGE = process.env.SCHRODUMP_TEST_POSTGRES_IMAGE ?? "postgres:18-alpine";

async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer(IMAGE)
    .withEnvironment({
      POSTGRES_USER: "schrodump",
      POSTGRES_PASSWORD: "schrodump",
      POSTGRES_DB: "app",
    })
    .withExposedPorts(5432)
    // -h forces pg_isready onto TCP. The image runs a socket-only server during init, and waiting
    // on the port alone connects inside that window.
    .withHealthCheck({
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d app"],
      interval: 1000,
      timeout: 3000,
      retries: 30,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
}

function urlFor(container: StartedTestContainer): string {
  return `postgresql://schrodump:schrodump@${container.getHost()}:${container.getMappedPort(5432)}/app?schema=public`;
}

// Runs a command inside the container and returns its stdout as raw bytes. testcontainers' own exec
// decodes to a string, which corrupts a binary pg_dump archive; this keeps the bytes intact.
function execInContainer(name: string, command: string[], env: Record<string, string>) {
  const args = ["exec", ...Object.keys(env).flatMap((key) => ["-e", `${key}=${env[key] ?? ""}`]), name, ...command];
  return new Promise<Buffer>((resolve, reject) => {
    execFile("docker", args, { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe.skipIf(!enabled)("self-backup recovery drill (integration)", () => {
  let source: StartedTestContainer;
  let target: StartedTestContainer;
  let sourcePrisma: PrismaClient;
  let sealed: Buffer;
  let escrowIdentity: string;
  let operationalIdentity: string;
  const marker = `recovery-drill-${Date.now()}`;

  beforeAll(async () => {
    [source, target] = await Promise.all([startPostgres(), startPostgres()]);

    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: urlFor(source) },
    });

    // A catalog with something in it, so "the catalog came back" is a claim about data and not
    // about an empty schema being recreated.
    sourcePrisma = new PrismaClient({ datasourceUrl: urlFor(source) });
    await sourcePrisma.organization.create({ data: { name: marker, slug: marker } });

    const escrow = await generateAgeKeyPair();
    const operational = await generateAgeKeyPair();
    escrowIdentity = escrow.identity;
    operationalIdentity = operational.identity;

    // The production selection, not a hand-picked recipient list: escrow first, and it throws if
    // escrow is missing.
    const chosen = selectSelfBackupRecipients([
      {
        keyId: escrow.keyId,
        type: "escrow",
        publicRecipient: escrow.recipient,
        state: "active",
      },
    ]);
    expect(chosen.recipients).toEqual([escrow.recipient]);

    // The command under test is the one production builds, not an approximation of it.
    const descriptor = resolveAdapter("postgres").buildDump({
      connection: {
        host: "127.0.0.1",
        port: 5432,
        database: "app",
        username: "schrodump",
        password: "schrodump",
        tls: false,
      },
      serverVersionNum: 180_000,
      executionMode: "STREAM",
      parallelism: 1,
      scope: { databases: ["app"], schemas: [], collections: [] },
      facts: { isReplicaSet: false, hasMyisam: false },
    });
    const plaintext = await execInContainer(
      source.getName().replace(/^\//, ""),
      descriptor.command,
      descriptor.env,
    );
    expect(plaintext.byteLength).toBeGreaterThan(0);

    sealed = await collect(
      await encryptStream(Readable.from([plaintext]).pipe(createGzip()), chosen.recipients),
    );
  }, 300_000);

  afterAll(async () => {
    if (sourcePrisma !== undefined) await sourcePrisma.$disconnect();
    await Promise.all([source?.stop(), target?.stop()]);
  });

  it("cannot be opened by the operational identity", async () => {
    // The decoy check, proven rather than argued. If a self-backup were ever sealed to the
    // operational key alone, this is the identity that would be gone with the database.
    await expect(decryptStream(Readable.from([sealed]), operationalIdentity)).rejects.toThrow();
  });

  it("opens with the offline escrow identity and restores into an empty database", async () => {
    const dump = await collect((await decryptStream(Readable.from([sealed]), escrowIdentity)).pipe(createGunzip()));

    // pg_restore reading the archive on stdin, inside the empty target — the operator's step 3.
    const restore = execFile(
      "docker",
      [
        "exec", "-i",
        "-e", "PGPASSWORD=schrodump",
        target.getName().replace(/^\//, ""),
        "pg_restore", "-h", "127.0.0.1", "-U", "schrodump", "-d", "app", "--no-owner",
      ],
      { encoding: "buffer" },
    );
    await pipeline(Readable.from([dump]), restore.stdin!);
    await new Promise<void>((resolve, reject) => {
      restore.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_restore exited ${String(code)}`))));
    });

    const targetPrisma = new PrismaClient({ datasourceUrl: urlFor(target) });
    try {
      const org = await targetPrisma.organization.findFirst({ where: { slug: marker } });
      expect(org?.name).toBe(marker);
    } finally {
      await targetPrisma.$disconnect();
    }
  }, 120_000);
});
