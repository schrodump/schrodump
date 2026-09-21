// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The globals dump against a role that is not a superuser — which is what every managed postgres
// hands out (RDS, Cloud SQL, Azure, Supabase, Neon, ...) and what a least-privilege backup role is.
//
// Every postgres backup runs `pg_dumpall --globals-only` beside the database dump, and pg_dumpall
// reads pg_authid unless told --no-role-passwords. Nobody but a superuser may, so the first backup
// of every managed postgres FAILED at this step with `permission denied for table pg_authid`. The
// descriptor now decides from a probe fact, and whether that fact is right is a question only a
// real server answers: the probe runs as the role, the descriptor is built from what it reported,
// and pg_dumpall runs against the same server.
//
// The negative control is the point: the same role, asked for passwords, is still refused — so the
// passing case passes because of the flag, not because the fixture role could read pg_authid.

import { spawnSync } from "node:child_process";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DumpInput,
  ExecutionDescriptor,
  TargetConnection,
  TargetFacts,
} from "../descriptor.js";
import { probePostgres } from "../probe/postgres.js";
import { postgresAdapter } from "./postgres.js";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const IMAGE = process.env.SCHRODUMP_TEST_POSTGRES_IMAGE ?? "postgres:18-alpine";
const SUPERUSER = { username: "schrodump", password: "s3cret-integration" };
// CONNECT on its database, USAGE on the schema, SELECT on the tables: enough to pg_dump it, and
// nothing that reaches pg_authid.
const READER = { username: "reader", password: "reader-integration" };

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

describe.skipIf(!enabled)("postgres globals dump by a role that cannot read pg_authid", () => {
  let container: StartedTestContainer;
  let superuserFacts: TargetFacts;
  let readerFacts: TargetFacts;

  // Runs a descriptor's command in the target's own container: the same image and the same
  // pg_dumpall the executor resolves for this server version. The exit status and stderr are
  // returned rather than thrown, because one case below exists to watch it fail.
  function run(command: string[], env: Record<string, string>): Ran {
    const result = spawnSync(
      "docker",
      [
        "exec",
        ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        container.getName().replace(/^\//, ""),
        ...command,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function sql(statement: string): void {
    const result = run(
      [
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        SUPERUSER.username,
        "-d",
        "app",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement,
      ],
      { PGPASSWORD: SUPERUSER.password },
    );
    if (result.status !== 0) throw new Error(`fixture SQL failed: ${result.stderr}`);
  }

  // Inside the container the server is on 127.0.0.1:5432; the probe, from the host, uses the
  // mapped port.
  const insideConnection = (role: { username: string; password: string }): TargetConnection => ({
    host: "127.0.0.1",
    port: 5432,
    database: "app",
    username: role.username,
    password: role.password,
    tls: false,
  });

  const globalsDumpFor = (
    role: { username: string; password: string },
    facts: TargetFacts,
  ): ExecutionDescriptor => {
    const input: DumpInput = {
      connection: insideConnection(role),
      serverVersionNum: 180000,
      executionMode: "STREAM",
      parallelism: 1,
      scope: { databases: ["app"], schemas: [], collections: [] },
      facts,
    };
    const descriptor = postgresAdapter.buildGlobalsDump?.(input);
    if (descriptor === undefined) throw new Error("postgres must build a globals dump");
    return descriptor;
  };

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({
        POSTGRES_USER: SUPERUSER.username,
        POSTGRES_PASSWORD: SUPERUSER.password,
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      .withHealthCheck({
        test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d app"],
        interval: 1000,
        timeout: 3000,
        retries: 40,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();

    sql(
      "CREATE TABLE orders (id int primary key, v text); INSERT INTO orders VALUES (1, 'x'); " +
        `CREATE ROLE ${READER.username} LOGIN PASSWORD '${READER.password}'; ` +
        `GRANT CONNECT ON DATABASE app TO ${READER.username}; ` +
        `GRANT USAGE ON SCHEMA public TO ${READER.username}; ` +
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER.username};`,
    );

    const probeAs = async (role: { username: string; password: string }): Promise<TargetFacts> =>
      (
        await probePostgres({
          host: container.getHost(),
          port: container.getMappedPort(5432),
          database: "app",
          username: role.username,
          password: role.password,
          tls: false,
          connectTimeoutMs: 10_000,
        })
      ).facts;
    superuserFacts = await probeAs(SUPERUSER);
    readerFacts = await probeAs(READER);
  }, 300_000);

  afterAll(async () => {
    if (container !== undefined) await container.stop();
  });

  it("probes a superuser as able to read role passwords, and the least-privilege role as not", () => {
    expect(superuserFacts.canReadRolePasswords).toBe(true);
    expect(readerFacts.canReadRolePasswords).toBe(false);
  });

  it("dumps the globals as the least-privilege role, roles and all, without a single password", () => {
    const descriptor = globalsDumpFor(READER, readerFacts);
    const result = run(descriptor.command, descriptor.env);

    expect(result.status, result.stderr).toBe(0);
    // The roles are still there — restoring this recreates them, just without a password.
    expect(result.stdout).toMatch(/CREATE ROLE reader;/);
    expect(result.stdout).toMatch(/CREATE ROLE schrodump;/);
    expect(result.stdout).not.toMatch(/PASSWORD '/);
  }, 120_000);

  it("is refused for the same role when asked for passwords — the flag is what made it pass", () => {
    const descriptor = globalsDumpFor(READER, { ...readerFacts, canReadRolePasswords: true });
    expect(descriptor.command).not.toContain("--no-role-passwords");
    const result = run(descriptor.command, descriptor.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/permission denied for table pg_authid/);
  }, 120_000);

  it("keeps capturing role password hashes for a superuser", () => {
    const descriptor = globalsDumpFor(SUPERUSER, superuserFacts);
    const result = run(descriptor.command, descriptor.env);

    expect(result.status, result.stderr).toBe(0);
    // md5 on postgres 13, whose password_encryption default predates scram-sha-256.
    expect(result.stdout).toMatch(/ALTER ROLE reader WITH .* PASSWORD '(SCRAM-SHA-256\$|md5)/);
  }, 120_000);
});
