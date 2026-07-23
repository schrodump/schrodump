// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { ProbeConnection, ProbeResult } from "@schrodump/engines/probe/types";
import { describe, expect, it, vi } from "vitest";
import {
  classify,
  driverCodeOf,
  testTargetConnection,
  type EngineName,
  type ProbeFn,
  type ProbeTable,
  type ProbeTarget,
} from "./test-connection.js";

const PASSWORD = "correct-horse-battery-staple";

function target(overrides: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    engine: "postgres",
    host: "db.internal",
    port: 5432,
    username: "backup",
    password: PASSWORD,
    tls: true,
    databases: [],
    ...overrides,
  };
}

function result(serverVersionNum: number): ProbeResult {
  return {
    serverVersionNum,
    databases: [],
    scope: { databases: [], schemas: [], collections: [] },
    facts: {} as ProbeResult["facts"],
  };
}

function table(fn: (conn: ProbeConnection) => Promise<ProbeResult>): ProbeTable {
  return { postgres: fn, mysql: fn, mariadb: fn, mongodb: fn };
}

describe("testTargetConnection", () => {
  it("dispatches to the probe of the target's engine", async () => {
    const calls: EngineName[] = [];
    const probes: ProbeTable = {
      postgres: async () => { calls.push("postgres"); return result(160_004); },
      mysql: async () => { calls.push("mysql"); return result(80_036); },
      mariadb: async () => { calls.push("mariadb"); return result(110_006); },
      mongodb: async () => { calls.push("mongodb"); return result(80_000); },
    };

    for (const engine of ["postgres", "mysql", "mariadb", "mongodb"] as const) {
      await testTargetConnection(target({ engine }), probes);
    }
    expect(calls).toEqual(["postgres", "mysql", "mariadb", "mongodb"]);
  });

  it("reports the server version, which decides the executor image", async () => {
    const outcome = await testTargetConnection(target(), table(async () => result(160_004)));
    expect(outcome).toEqual({ ok: true, serverVersionNum: 160_004, failure: null, driverCode: null });
  });

  it("hands the decrypted password to the probe and nothing else", async () => {
    const probe = vi.fn<ProbeFn>(async () => result(160_004));
    await testTargetConnection(target(), table(probe));

    const conn = probe.mock.calls[0]?.[0] as ProbeConnection;
    expect(conn.password).toBe(PASSWORD);
    expect(conn.host).toBe("db.internal");
    expect(conn.tls).toBe(true);
    // An unreachable target must never hang the operator who clicked the button.
    expect(conn.connectTimeoutMs).toBeGreaterThan(0);
  });

  it("connects through the first scoped database for SQL engines", async () => {
    const probe = vi.fn<ProbeFn>(async () => result(160_004));
    await testTargetConnection(target({ databases: ["shop", "billing"] }), table(probe));
    expect((probe.mock.calls[0]?.[0] as ProbeConnection).database).toBe("shop");
  });

  it("falls back to the engine's own system database when the scope is empty", async () => {
    const probe = vi.fn<ProbeFn>(async () => result(1));
    await testTargetConnection(target({ engine: "postgres" }), table(probe));
    await testTargetConnection(target({ engine: "mysql" }), table(probe));
    expect((probe.mock.calls[0]?.[0] as ProbeConnection).database).toBe("postgres");
  });

  it("uses admin for MongoDB, where the field is the auth source and not a backup scope", async () => {
    const probe = vi.fn<ProbeFn>(async () => result(80_000));
    await testTargetConnection(target({ engine: "mongodb", databases: ["shop"] }), table(probe));
    expect((probe.mock.calls[0]?.[0] as ProbeConnection).database).toBe("admin");
  });

  // The reason this whole module exists rather than passing driver errors through.
  it("never lets the password reach the result, even when the driver error contains it", async () => {
    const leaky = Object.assign(
      new Error(`failed to connect to mongodb://backup:${PASSWORD}@db.internal:27017`),
      { code: 18 },
    );
    const outcome = await testTargetConnection(target({ engine: "mongodb" }), table(async () => {
      throw leaky;
    }));

    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe("AUTH_FAILED");
    // The driver code may travel; the credential and the prose that carried it may not.
    expect(outcome.driverCode).toBe("ERROR/18");
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
    expect(JSON.stringify(outcome)).not.toContain("mongodb://");
    expect(JSON.stringify(outcome)).not.toContain("backup:");
  });

  it("turns a thrown probe into a failure code instead of propagating it", async () => {
    const outcome = await testTargetConnection(
      target(),
      table(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }),
    );
    expect(outcome).toEqual({
      ok: false,
      serverVersionNum: null,
      failure: "UNREACHABLE",
      driverCode: "ERROR/ECONNREFUSED",
    });
  });
});

describe("classify", () => {
  it("recognises the drivers' documented codes", () => {
    expect(classify({ code: "ECONNREFUSED" })).toBe("UNREACHABLE");
    expect(classify({ code: "ENOTFOUND" })).toBe("UNREACHABLE");
    expect(classify({ code: "ETIMEDOUT" })).toBe("TIMEOUT");
    expect(classify({ code: "28P01" })).toBe("AUTH_FAILED"); // postgres invalid_password
    expect(classify({ code: "ER_ACCESS_DENIED_ERROR" })).toBe("AUTH_FAILED"); // mysql
    expect(classify({ code: 1045 })).toBe("AUTH_FAILED"); // mysql, numeric
    expect(classify({ codeName: "AuthenticationFailed" })).toBe("AUTH_FAILED"); // mongodb
    expect(classify({ code: "EPROTO" })).toBe("TLS_FAILED");
  });

  // Shapes observed against a real MongoDB, not invented: the driver reports connection-level
  // failures through the error class with no code whatsoever.
  it("classifies the MongoDB driver's codeless connection errors", () => {
    expect(
      classify({
        name: "MongoServerSelectionError",
        message: "Client network socket disconnected before secure TLS connection was established",
      }),
    ).toBe("TLS_FAILED");
    expect(classify({ name: "MongoServerSelectionError", message: "Server selection timed out" })).toBe("TIMEOUT");
    expect(classify({ name: "MongoNetworkError", message: "connection closed" })).toBe("UNREACHABLE");
    // Auth still wins over the class name: it carries a real code.
    expect(classify({ name: "MongoServerError", code: 18, codeName: "AuthenticationFailed" })).toBe("AUTH_FAILED");
  });

  it("separates a missing grant from a wrong password", () => {
    // The probe calls listDatabases, which an ordinary backup user is often not granted.
    expect(classify({ name: "MongoServerError", code: 13, codeName: "Unauthorized" })).toBe(
      "INSUFFICIENT_PRIVILEGES",
    );
    expect(classify({ name: "MongoServerError", message: "not authorized on admin to execute command" })).toBe(
      "INSUFFICIENT_PRIVILEGES",
    );
    expect(classify({ code: "42501" })).toBe("INSUFFICIENT_PRIVILEGES");
  });

  it("names the driver's error so an UNKNOWN can be reported", () => {
    expect(driverCodeOf({ name: "MongoServerError", code: 13 })).toBe("MONGOSERVERERROR/13");
    expect(driverCodeOf({ name: "MongoServerSelectionError" })).toBe("MONGOSERVERSELECTIONERROR");
    expect(driverCodeOf({})).toBeNull();
  });

  it("falls back to UNKNOWN rather than guessing from a message", () => {
    expect(classify(new Error("something went sideways"))).toBe("UNKNOWN");
    expect(classify(null)).toBe("UNKNOWN");
    expect(classify("boom")).toBe("UNKNOWN");
  });
});
