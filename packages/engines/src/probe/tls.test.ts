// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What each probe hands its driver in each TLS mode. The drivers are replaced so the options that
// actually reach `new Client(...)`, `createConnection(...)` and `new MongoClient(...)` are what is
// asserted — a test of a helper alone could pass while the probe kept passing something else.
//
// The failure these guard is the probe verifying where the tools did not: `{ rejectUnauthorized:
// true }` against Node's bundled CAs, with no way to add one, failed every managed database at
// test-connection and at the start of every backup.

import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeConnection } from "./types.js";

const seen = vi.hoisted(() => ({ pg: [] as unknown[], mysql: [] as unknown[], mongo: [] as unknown[] }));

// Each fake records its options and then refuses to connect, which ends the probe right there.
vi.mock("pg", () => ({
  Client: class {
    constructor(config: unknown) {
      seen.pg.push(config);
    }
    connect(): Promise<void> {
      return Promise.reject(new Error("stop"));
    }
  },
}));
vi.mock("mysql2/promise", () => ({
  createConnection: (config: unknown) => {
    seen.mysql.push(config);
    return Promise.reject(new Error("stop"));
  },
}));
vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(_url: string, options: unknown) {
      seen.mongo.push(options);
    }
    connect(): Promise<void> {
      return Promise.reject(new Error("stop"));
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const { probePostgres } = await import("./postgres.js");
const { probeMysql } = await import("./mysql.js");
const { probeMongodb } = await import("./mongodb.js");

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const BASE: ProbeConnection = {
  host: "db.internal",
  port: 5432,
  database: "app",
  username: "backup",
  password: "s3cret",
  tls: true,
  connectTimeoutMs: 1000,
};
const OFF: ProbeConnection = { ...BASE, tls: false };
const REQUIRE: ProbeConnection = { ...BASE };
const VERIFY: ProbeConnection = { ...BASE, tlsCaCert: PEM };

async function optionsOf<T>(probe: (conn: ProbeConnection) => Promise<unknown>, conn: ProbeConnection, bucket: unknown[]): Promise<T> {
  await expect(probe(conn)).rejects.toThrow("stop");
  return bucket.at(-1) as T;
}

beforeEach(() => {
  seen.pg.length = 0;
  seen.mysql.length = 0;
  seen.mongo.length = 0;
});

describe("probePostgres hands pg the mode pg_dump is told", () => {
  type Ssl = false | { ca?: string; rejectUnauthorized?: boolean; checkServerIdentity?: (n: string, c: PeerCertificate) => Error | undefined };
  const sslOf = async (conn: ProbeConnection) =>
    (await optionsOf<{ ssl: Ssl }>(probePostgres, conn, seen.pg)).ssl;

  it("disable: no TLS", async () => {
    expect(await sslOf(OFF)).toBe(false);
  });

  it("require: encrypted, certificate unverified — sslmode=require", async () => {
    expect(await sslOf(REQUIRE)).toEqual({ rejectUnauthorized: false });
  });

  it("verify-full: the target's CA, verification on", async () => {
    const ssl = await sslOf(VERIFY);
    expect(ssl).toMatchObject({ ca: PEM, rejectUnauthorized: true });
  });

  // pg gives tls.connect no host, so Node would check an IP-literal target's certificate against
  // "localhost". The override must check the CONFIGURED host, whatever name Node offers it.
  it("verify-full: checks the name against the configured host, not the one Node falls back to", async () => {
    const ssl = await sslOf({ ...VERIFY, host: "10.0.0.5" });
    if (ssl === false || ssl.checkServerIdentity === undefined) throw new Error("no identity check");
    const localhostOnly = { subject: { CN: "localhost" }, subjectaltname: "DNS:localhost" } as PeerCertificate;
    const forTheAddress = { subject: { CN: "db" }, subjectaltname: "IP Address:10.0.0.5" } as PeerCertificate;
    expect(ssl.checkServerIdentity("localhost", localhostOnly)).toBeInstanceOf(Error);
    expect(ssl.checkServerIdentity("localhost", forTheAddress)).toBeUndefined();
    // And it agrees with Node's own check for that host.
    expect(checkServerIdentity("10.0.0.5", forTheAddress)).toBeUndefined();
  });
});

describe("probeMysql hands mysql2 the mode the client flags ask for", () => {
  const sslOf = async (conn: ProbeConnection) =>
    (await optionsOf<{ ssl?: unknown }>(probeMysql, conn, seen.mysql)).ssl;

  it("disable: no ssl key at all", async () => {
    const options = await optionsOf<Record<string, unknown>>(probeMysql, OFF, seen.mysql);
    expect(options).not.toHaveProperty("ssl");
  });

  it("require: encrypted, certificate unverified — --ssl-mode=REQUIRED", async () => {
    expect(await sslOf(REQUIRE)).toEqual({ rejectUnauthorized: false });
  });

  // Without verifyIdentity mysql2 checks the chain and never the name: VERIFY_CA, not VERIFY_IDENTITY.
  it("verify-full: the target's CA, verification on, and the host name checked", async () => {
    expect(await sslOf(VERIFY)).toEqual({ ca: PEM, rejectUnauthorized: true, verifyIdentity: true });
  });
});

describe("probeMongodb hands the driver the mode the tools use", () => {
  const tlsOf = async (conn: ProbeConnection) => {
    const options = await optionsOf<Record<string, unknown>>(probeMongodb, conn, seen.mongo);
    return { tls: options["tls"], ca: options["ca"] };
  };

  it("disable: tls false", async () => {
    expect(await tlsOf(OFF)).toEqual({ tls: false, ca: undefined });
  });

  it("require: tls on, verified against the bundled store — the tools' own default", async () => {
    expect(await tlsOf(REQUIRE)).toEqual({ tls: true, ca: undefined });
  });

  it("verify-full: tls on with the target's CA", async () => {
    expect(await tlsOf(VERIFY)).toEqual({ tls: true, ca: PEM });
  });
});
