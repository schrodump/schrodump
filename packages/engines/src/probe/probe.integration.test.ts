// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
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

// Pinned by default so a normal run is reproducible, overridable so the supported-range edges and
// MariaDB can be exercised without editing test code. CI's own comment asked for exactly this: the
// gap was never that the versions were wrong, it was that they were unreachable from outside.
const POSTGRES_IMAGE = process.env.SCHRODUMP_TEST_POSTGRES_IMAGE ?? "postgres:16-alpine";
const MYSQL_IMAGE = process.env.SCHRODUMP_TEST_MYSQL_IMAGE ?? "mysql:8.0";
const MONGO_IMAGE = process.env.SCHRODUMP_TEST_MONGO_IMAGE ?? "mongo:8";

describe.skipIf(!enabled)("probe integration (testcontainers)", () => {
  it("probes a real postgres", async () => {
    const container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_USER: "schrodump",
        POSTGRES_PASSWORD: "schrodump",
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      // NOT Wait.forListeningPorts(). The postgres image runs a TEMPORARY socket-only server during
      // initialisation, then stops it and starts the real one; the mapped port is reachable during
      // that window and a probe against it fails with "the database system is starting up". `-h`
      // forces pg_isready onto TCP, which only the real server listens on.
      //
      // This lesson was already written down in claim.test.ts and in adapters/postgres.ts — and
      // claim.test.ts even cites THIS file as having learned it. It had not: this case still waited
      // on the port, and it failed in CI on 2026-09-01. A flake that reads as a code failure trains
      // everyone to re-run a red CI, which is how a real red gets waved through.
      .withHealthCheck({
        test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d app"],
        interval: 1000,
        timeout: 3000,
        retries: 30,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    try {
      const result = await probePostgres(connFor(container, 5432, "app", "schrodump"));
      expect(result.serverVersionNum).toBeGreaterThan(130000);
      expect(result.databases.length).toBeGreaterThan(0);
    } finally {
      await container.stop();
    }
  }, 120_000);

  it("probes a real mysql and reports MyISAM presence as a boolean", async () => {
    // Waiting on the log is not enough here: the init phase starts a temporary server that
    // logs "ready for connections" twice (server plus X Plugin) over a socket with no TCP, so
    // the wait is satisfied before the real server exists and the probe gets its connection
    // closed underneath it. The healthcheck forces TCP against 127.0.0.1, which only the final
    // server binds.
    const container = await new GenericContainer(MYSQL_IMAGE)
      .withEnvironment({ MYSQL_ROOT_PASSWORD: "schrodump", MYSQL_DATABASE: "app" })
      .withExposedPorts(3306)
      .withHealthCheck({
        // Both binaries, because this test also runs against MariaDB via SCHRODUMP_TEST_MYSQL_IMAGE.
        // MariaDB 11 renamed the client tools to mariadb-*, and a bare `mysqladmin` healthcheck
        // there never turns healthy — the container just times out after 60s with no hint why.
        test: [
          "CMD-SHELL",
          "mariadb-admin ping -h 127.0.0.1 -uroot -pschrodump --silent || mysqladmin ping -h 127.0.0.1 -uroot -pschrodump --silent",
        ],
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
  }, 180_000);

  it("probes a real mongodb standalone (not a replica set)", async () => {
    const container = await new GenericContainer(MONGO_IMAGE)
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
  }, 180_000);

  it("probes a real mongodb REPLICA SET and reports the fact the oplog chain keys on", async () => {
    // isReplicaSet is the single input that decides whether buildDump emits --oplog, whether that
    // fact is recorded on the artifact, and therefore whether a FULL_CLUSTER restore replays the
    // oplog. All of that was unit-tested only, because CI ran no replica set — so the one thing
    // the chain hangs from was never observed against a real one.
    //
    // A replica set with auth needs a keyfile for internal auth even at a single member, and the
    // keyfile is created INSIDE the container rather than mounted. It has to be, and the reason is
    // a trap this repository has already been bitten by once (see the 0644 note on the restore dump
    // in restore-executor.ts): mongod refuses a keyfile that is group- or other-readable, so it
    // must be 0600 — but the mongo entrypoint gosu-drops to the unprivileged `mongodb` user, and on
    // native Linux a bind-mounted 0600 file keeps the HOST uid, which `mongodb` is not. Mounting it
    // works on Docker Desktop, whose file sharing masks ownership, and fails on CI. Writing it
    // in-container as root and chowning satisfies both.
    const keyfile = randomBytes(32).toString("base64");
    const container = await new GenericContainer(MONGO_IMAGE)
      .withEnvironment({
        MONGO_INITDB_ROOT_USERNAME: "root",
        MONGO_INITDB_ROOT_PASSWORD: "schrodump",
        MONGO_KEYFILE: keyfile,
      })
      .withUser("0")
      .withEntrypoint(["/bin/sh", "-c"])
      .withCommand([
        'printf "%s" "$MONGO_KEYFILE" > /tmp/mongo-keyfile && chmod 600 /tmp/mongo-keyfile && ' +
          "chown mongodb /tmp/mongo-keyfile && " +
          "exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /tmp/mongo-keyfile --bind_ip_all",
      ])
      // Fixed host port, unlike every other container here. A replica set member advertises an
      // address in its own config, and the driver switches to that address after topology
      // discovery — so the member's host:port has to mean the same thing inside the container and
      // out. A random mapped port cannot satisfy both. Production does not have this problem: its
      // members advertise names that resolve on the network the server sits on.
      .withExposedPorts({ container: 27017, host: 27017 })
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    try {
      const auth = ["-u", "root", "-p", "schrodump", "--authenticationDatabase", "admin"];
      // forListeningPorts is satisfied by the temporary bootstrap mongod, so poll for the real one.
      for (let i = 0; i < 60; i++) {
        const ping = await container.exec([
          "mongosh",
          "--quiet",
          ...auth,
          "--eval",
          "db.adminCommand('ping').ok",
        ]);
        if (ping.exitCode === 0 && ping.output.includes("1")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const initiate = await container.exec([
        "mongosh",
        "--quiet",
        ...auth,
        "--eval",
        "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}).ok",
      ]);
      expect(initiate.exitCode).toBe(0);
      // Election takes a moment; setName is only reported once the member is primary.
      for (let i = 0; i < 60; i++) {
        const hello = await container.exec([
          "mongosh",
          "--quiet",
          ...auth,
          "--eval",
          "db.hello().setName",
        ]);
        if (hello.output.includes("rs0")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      const result = await probeMongodb(connFor(container, 27017, "admin", "root"));
      expect(result.facts.isReplicaSet).toBe(true);
    } finally {
      await container.stop();
    }
  }, 300_000);
});
