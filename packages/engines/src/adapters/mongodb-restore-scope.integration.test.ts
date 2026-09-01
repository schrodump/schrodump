// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The condition docs/roadmap.md set for bringing mongo sub-scope restore back: "an integration
// test that proves a scoped restore leaves neighbouring namespaces untouched".
//
// A descriptor test can only show that --nsInclude appears on the command line. It cannot show
// what mongorestore then does with --drop, and that is the entire question: before scoping, a
// DATABASE restore dropped and overwrote EVERY namespace in the archive to write one of them back.
// This runs the real command the adapter builds, against a real mongod, and checks the neighbour.
//
// The negative control matters as much as the assertion: the neighbour is modified AFTER the dump
// is taken, so if the restore reached it, the modification would be gone. A test that only checked
// "the scoped database came back" would pass just as happily while destroying everything else.

import { execFileSync } from "node:child_process";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mongodbAdapter, MONGO_CONFIG_PATH } from "./mongodb.js";
import type { RestoreInput, TargetConnection } from "../descriptor.js";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const IMAGE = process.env.SCHRODUMP_TEST_MONGO_IMAGE ?? "mongo:8";
const PASSWORD = "s3cret-integration";
const ARCHIVE = "/tmp/dump.archive";

const CONN: TargetConnection = {
  host: "127.0.0.1",
  port: 27017,
  username: "root",
  password: PASSWORD,
  database: "admin",
  tls: false,
};

describe.skipIf(!enabled)("mongo sub-scope restore leaves neighbours alone (integration)", () => {
  let container: StartedTestContainer;

  function exec(command: string[], env: Record<string, string> = {}): string {
    const args = [
      "exec",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      container.getName().replace(/^\//, ""),
      ...command,
    ];
    return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }

  function mongosh(script: string): string {
    return exec([
      "mongosh",
      "--quiet",
      "-u",
      "root",
      "-p",
      PASSWORD,
      "--authenticationDatabase",
      "admin",
      "--eval",
      script,
    ]);
  }

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: PASSWORD })
      .withExposedPorts(27017)
      // Matches how the probe suite waits for mongo. The port opening is not proof the server will
      // authenticate yet, so the readiness loop below is the actual gate.
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    // mongod accepts connections before the init script has finished creating the root user, and
    // an auth failure here would look like a broken test rather than a race.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        mongosh("db.adminCommand({ ping: 1 });");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // The password file the descriptor references. In production the server writes this into
    // scratch and mounts it; here it only has to exist at the same path.
    exec(["mkdir", "-p", "/etc/schrodump"]);
    exec(["sh", "-c", `printf 'password: %s\\n' '${PASSWORD}' > ${MONGO_CONFIG_PATH}`]);

    // Two databases. `restoreme` is the target of the scoped restore; `keepme` is the neighbour
    // whose survival is the point of the test.
    mongosh(
      `db.getSiblingDB("restoreme").r.insertOne({ _id: 1, v: "from-the-dump" });` +
        // A sibling collection in the SAME database, and it has to be IN the archive: a collection
        // the archive does not contain survives an unscoped restore anyway, because --drop only
        // drops what it is about to write. Asserting on one of those would prove nothing — the
        // first version of this test did exactly that and passed under the mutation.
        `db.getSiblingDB("restoreme").sibling.insertOne({ _id: 1, v: "from-the-dump" });` +
        `db.getSiblingDB("keepme").k.insertOne({ _id: 1, v: "from-the-dump" });`,
    );

    exec([
      "mongodump",
      "--host",
      "127.0.0.1",
      "--port",
      "27017",
      "--username",
      "root",
      "--authenticationDatabase",
      "admin",
      "--config",
      MONGO_CONFIG_PATH,
      `--archive=${ARCHIVE}`,
    ]);
  }, 300_000);

  afterAll(async () => {
    if (container !== undefined) await container.stop();
  });

  it("restores only the requested database and does not touch the neighbour", () => {
    // Written AFTER the dump, so it exists in the live database and NOT in the archive. If the
    // restore reaches `keepme`, --drop removes the collection and this document disappears with it.
    mongosh(`db.getSiblingDB("keepme").k.insertOne({ _id: 2, v: "written-after-the-dump" });`);
    // And make the scoped database visibly stale, so "it came back" is a real observation.
    mongosh(`db.getSiblingDB("restoreme").r.deleteMany({});`);

    const input: RestoreInput = {
      connection: CONN,
      serverVersionNum: 80000,
      target: "DATABASE",
      scope: { databases: ["restoreme"], schemas: [], collections: [] },
      executionMode: "STREAM",
      sourcePath: ARCHIVE,
    };
    // The command under test is the one production builds, not an approximation of it.
    const descriptor = mongodbAdapter.buildRestore(input);
    expect(descriptor.command).toContain("--nsInclude=restoreme.*");
    exec(descriptor.command, descriptor.env);

    // The scoped database came back...
    const restored = mongosh(`print(db.getSiblingDB("restoreme").r.countDocuments({}));`).trim();
    expect(restored).toBe("1");

    // ...and the neighbour still has BOTH documents, including the one that exists only in the
    // live database. Before --nsInclude scoping this assertion is what fails: --drop would have
    // taken keepme.k with it and restored the archive's one-document version.
    const neighbour = mongosh(`print(db.getSiblingDB("keepme").k.countDocuments({}));`).trim();
    expect(neighbour).toBe("2");
    const survived = mongosh(
      `print(db.getSiblingDB("keepme").k.countDocuments({ v: "written-after-the-dump" }));`,
    ).trim();
    expect(survived).toBe("1");
  }, 300_000);

  it("scopes a COLLECTION restore to that collection, leaving its siblings in the same database", () => {
    // Written after the dump, into a collection the archive DOES contain. If the restore reaches
    // `sibling`, --drop takes this document with it.
    mongosh(
      `db.getSiblingDB("restoreme").sibling.insertOne({ _id: 2, v: "written-after-the-dump" });` +
        `db.getSiblingDB("restoreme").r.deleteMany({});`,
    );

    const descriptor = mongodbAdapter.buildRestore({
      connection: CONN,
      serverVersionNum: 80000,
      target: "COLLECTION",
      scope: { databases: ["restoreme"], schemas: [], collections: ["r"] },
      executionMode: "STREAM",
      sourcePath: ARCHIVE,
    });
    expect(descriptor.command).toContain("--nsInclude=restoreme.r");
    exec(descriptor.command, descriptor.env);

    expect(mongosh(`print(db.getSiblingDB("restoreme").r.countDocuments({}));`).trim()).toBe("1");
    // The tighter case: database-level scoping would already have protected `keepme`, and would
    // NOT protect this. Two documents means --drop never reached the sibling.
    expect(
      mongosh(`print(db.getSiblingDB("restoreme").sibling.countDocuments({}));`).trim(),
    ).toBe("2");
  }, 300_000);
});
