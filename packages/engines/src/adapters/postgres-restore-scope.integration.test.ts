// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The condition for bringing TABLE-scoped restore back for postgres: a mechanism that provably
// filters, plus an integration test proving a neighbouring table survives.
//
// TABLE was withdrawn because buildRestore emitted -n for SCHEMA and nothing at all for TABLE, so
// a TABLE request ran `pg_restore --clean` over the WHOLE dump — every table in the database
// dropped and replaced to write one of them. `-t` is the mechanism postgres actually provides, and
// unlike `mysql --one-database` it is not documented as rudimentary. Whether --clean then confines
// itself to the selected table is the question a descriptor test cannot answer, so this asks it of
// a real server.
//
// The negative control is the whole point: the neighbouring table is modified AFTER the dump, so a
// restore that reaches it destroys the modification.

import { execFileSync } from "node:child_process";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresAdapter } from "./postgres.js";
import type { TargetConnection } from "../descriptor.js";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const IMAGE = process.env.SCHRODUMP_TEST_POSTGRES_IMAGE ?? "postgres:18-alpine";
const PASSWORD = "s3cret-integration";
const DUMP = "/tmp/dump.fc";

const CONN: TargetConnection = {
  host: "127.0.0.1",
  port: 5432,
  username: "schrodump",
  password: PASSWORD,
  database: "app",
  tls: false,
};

describe.skipIf(!enabled)("postgres TABLE restore leaves neighbours alone (integration)", () => {
  let container: StartedTestContainer;

  function exec(command: string[], env: Record<string, string> = {}): string {
    const args = [
      "exec",
      ...Object.entries({ PGPASSWORD: PASSWORD, ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      container.getName().replace(/^\//, ""),
      ...command,
    ];
    return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }

  function sql(statement: string): string {
    return exec(["psql", "-h", "127.0.0.1", "-U", "schrodump", "-d", "app", "-tAc", statement]);
  }

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({
        POSTGRES_USER: "schrodump",
        POSTGRES_PASSWORD: PASSWORD,
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

    // Two tables. `wanted` is the target of the scoped restore; `neighbour` is the one whose
    // survival is the point — and it must be IN the dump, or --clean would never have touched it
    // and the assertion would prove nothing.
    sql(
      "CREATE TABLE wanted (id int primary key, v text); " +
        "CREATE TABLE neighbour (id int primary key, v text); " +
        "INSERT INTO wanted VALUES (1,'from-the-dump'); " +
        "INSERT INTO neighbour VALUES (1,'from-the-dump');",
    );
    // -Fc, the format buildDump produces for STREAM.
    exec(["sh", "-c", `pg_dump -h 127.0.0.1 -U schrodump -d app -Fc > ${DUMP}`]);
  }, 300_000);

  afterAll(async () => {
    if (container !== undefined) await container.stop();
  });

  it("restores only the requested table and does not touch its neighbour", () => {
    // Written after the dump, into a table the dump DOES contain. If the restore reaches
    // `neighbour`, --clean drops it and this row goes with it.
    sql("INSERT INTO neighbour VALUES (2,'written-after-the-dump');");
    sql("DELETE FROM wanted;");

    const descriptor = postgresAdapter.buildRestore({
      connection: CONN,
      serverVersionNum: 180000,
      target: "TABLE",
      scope: { databases: ["app"], schemas: [], collections: [], tables: ["wanted"] },
      executionMode: "STREAM",
      sourcePath: DUMP,
    });
    expect(descriptor.command).toContain("-t");
    expect(descriptor.command).toContain("wanted");
    exec(descriptor.command, descriptor.env);

    // The requested table came back...
    expect(sql("SELECT count(*) FROM wanted;").trim()).toBe("1");
    // ...and the neighbour kept BOTH rows, including the one that exists only in the live
    // database. Without -t this is what fails: --clean would have dropped `neighbour` and
    // restored the dump's single-row version.
    expect(sql("SELECT count(*) FROM neighbour;").trim()).toBe("2");
    expect(
      sql("SELECT count(*) FROM neighbour WHERE v = 'written-after-the-dump';").trim(),
    ).toBe("1");
  }, 300_000);

  it("refuses a TABLE restore that names no table, rather than restoring everything", () => {
    expect(() =>
      postgresAdapter.buildRestore({
        connection: CONN,
        serverVersionNum: 180000,
        target: "TABLE",
        scope: { databases: ["app"], schemas: [], collections: [], tables: [] },
        executionMode: "STREAM",
        sourcePath: DUMP,
      }),
    ).toThrow();
  });
});
