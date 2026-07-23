// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { probeMongodb } from "./mongodb.js";
import { probeMysql } from "./mysql.js";
import { probePostgres } from "./postgres.js";
import type { ProbeConnection } from "./types.js";

// Opt-in only: needs Docker. Skipped unless SCHRODUMP_TEST_INTEGRATION=1, so a CI runner
// without Docker is never affected.
const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";

function connFor(
  container: StartedTestContainer,
  port: number,
  database: string,
  username: string,
): ProbeConnection {
  return {
    host: container.getHost(),
    port: container.getMappedPort(port),
    database,
    username,
    password: "schrodump",
    tls: false, // local containers have no TLS — an explicit opt-out, not a silent fallback
    connectTimeoutMs: 10_000,
  };
}

describe.skipIf(!enabled)("probe integration (testcontainers)", () => {
  it(
    "probes a real postgres",
    async () => {
      const container = await new GenericContainer("postgres:16-alpine")
        .withEnvironment({
          POSTGRES_USER: "schrodump",
          POSTGRES_PASSWORD: "schrodump",
          POSTGRES_DB: "app",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
      try {
        const result = await probePostgres(connFor(container, 5432, "app", "schrodump"));
        expect(result.serverVersionNum).toBeGreaterThan(130000);
        expect(result.databases.length).toBeGreaterThan(0);
      } finally {
        await container.stop();
      }
    },
    120_000,
  );

  it(
    "probes a real mysql and reports MyISAM presence as a boolean",
    async () => {
      // Waiting on the log is not enough here: the init phase starts a temporary server that
      // logs "ready for connections" twice (server plus X Plugin) over a socket with no TCP, so
      // the wait is satisfied before the real server exists and the probe gets its connection
      // closed underneath it. The healthcheck forces TCP against 127.0.0.1, which only the final
      // server binds.
      const container = await new GenericContainer("mysql:8.0")
        .withEnvironment({ MYSQL_ROOT_PASSWORD: "schrodump", MYSQL_DATABASE: "app" })
        .withExposedPorts(3306)
        .withHealthCheck({
          test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -pschrodump --silent"],
          interval: 2000,
          timeout: 5000,
          retries: 30,
          startPeriod: 5000,
        })
        .withWaitStrategy(Wait.forHealthCheck())
        .start();
      try {
        const result = await probeMysql(connFor(container, 3306, "mysql", "root"));
        expect(result.serverVersionNum).toBeGreaterThan(80000);
        expect(typeof result.facts.hasMyisam).toBe("boolean");
      } finally {
        await container.stop();
      }
    },
    180_000,
  );

  it(
    "probes a real mongodb standalone (not a replica set)",
    async () => {
      const container = await new GenericContainer("mongo:8")
        .withEnvironment({
          MONGO_INITDB_ROOT_USERNAME: "root",
          MONGO_INITDB_ROOT_PASSWORD: "schrodump",
        })
        .withExposedPorts(27017)
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
      try {
        const result = await probeMongodb(connFor(container, 27017, "admin", "root"));
        expect(result.serverVersionNum).toBeGreaterThan(60000);
        expect(result.facts.isReplicaSet).toBe(false);
      } finally {
        await container.stop();
      }
    },
    180_000,
  );
});
