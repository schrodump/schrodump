// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import type { ProbeTarget, TestConnectionResult } from "../probe/test-connection.js";
import {
  allowAnyEgress,
  defaultPolicyGuard,
  refuseAnyEgress,
  REFUSAL,
} from "../egress/guard.fixture.js";
import { EgressRefusedError, type EgressGuard } from "../egress/guard.js";
import {
  parseTlsCaCert,
  scopeProblem,
  targetRoutes,
  TLS_CA_CERT_MAX_BYTES,
  type CreateTargetData,
  type TargetRecord,
  type TargetStore,
  type UpdateTargetData,
} from "./targets.js";

// A real certificate — a throwaway CA generated with openssl for the TLS checks, whose key was
// discarded — so the parse check below is exercised against real DER, not a lookalike string.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDGTCCAgGgAwIBAgIUMGHMoUlysxM4gd601frgt6JuvTcwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRZW4wMiB0aHJvd2F3YXkgQ0EwHhcNMjYwOTIxMTMyMjA0
WhcNMjYwOTIzMTMyMjA0WjAcMRowGAYDVQQDDBFlbjAyIHRocm93YXdheSBDQTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMTM+XXNTr4BrCKHhYnMB+fv
Ls3riK/ccTkQrm1bgN8M0cbQ6qWAqEtbfFxQ4gIomw1GrpL8O4iL9WR6FjAQOGol
vOIq6CjQilTMK1/mt21nmHKmEBWNMdZMu6NoUb+RvQOwY5KrRK97Y1O7GjCwTk9d
fp7nPqrI9nVSdD+Av5+ZkrqyNhZjYzniW+xwEdA8JCKq5SaIeHMVIZAUopbHL6BY
CsFkmznb4CNwwmUUdlykjJuE/XLTMqVsztpJnrBquDQ1boSfH4QzCaxuqtguoBfz
BAe3DthK6lUXWSTggYL7455dJ2KvrQkOo/xr8JnLemjBbpDkJ2NpEcFnwRhQbNsC
AwEAAaNTMFEwHQYDVR0OBBYEFMyRcr/HRvG0goZqqrehhb17E3N/MB8GA1UdIwQY
MBaAFMyRcr/HRvG0goZqqrehhb17E3N/MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBAMMxl44RdnOcq5quyOnUQIIQuZcDswT0yqjdIlm/cWMnNmSR
Ys8Q6QNABqGPjVam0MQKzriVaFyzTpYpQXtJnMCoRlFRnkaBisL9xPIxsEXqqode
USpJ+oX62Zqj4ypdT2s1Nu7jrTLYSTuZANBQgGAAYOmkZnpswv0OYZXl7uIqLY5F
BN32Ro79xTpufWYjt0i56ab2s+kFn8WE4krkBRI+kszdPedyVVcJZal4dfzn29wN
EpBzScjO5b/DqLkXClq8Avgk0klDW0d+u6jP2w0zE46ys6iEO+xGxjU7QgOdfHRi
3c65A3ur1N6/jWgI5Xgd5pKQjJcnpk2JtxxdKyQ=
-----END CERTIFICATE-----
`;

const RECORD: TargetRecord = {
  id: "t1",
  name: "prod-db",
  engine: "postgres",
  host: "db.internal",
  port: 5432,
  username: "backup",
  tls: true,
  tlsCaCert: null,
  scope: { databases: ["app"], schemas: [], collections: [] },
  encryptedCredential: { v: 1, dek: "WRAPPED-DEK", data: "CIPHERTEXT" },
  createdAt: new Date("2026-07-23T12:00:00Z"),
  updatedAt: new Date("2026-07-23T12:00:00Z"),
  lastProbeAt: new Date("2026-09-03T12:00:00Z"),
  lastProbeOk: true,
  lastProbeFailure: null,
};

const STORE: TargetStore = {
  create: () => Promise.resolve(RECORD),
  list: () => Promise.resolve([RECORD]),
  get: () => Promise.resolve(RECORD),
  update: () => Promise.resolve(RECORD),
  remove: () => Promise.resolve({ ok: true }),
};

// What a healthy probe of a two-database postgres server reports — the exact shape of the
// deployment where an unscoped target picked the wrong one.
const DISCOVERED: TestConnectionResult = {
  ok: true,
  serverVersionNum: 170_011,
  failure: null,
  driverCode: null,
  databases: [
    { name: "acme_finance", sizeBytes: 9_896_000_000 },
    { name: "postgres", sizeBytes: 7_690_000 },
  ],
  isReplicaSet: false,
};

async function appWith(
  role: Role | null,
  over: Partial<TargetStore> = {},
  probe: (target: ProbeTarget) => Promise<TestConnectionResult> = () => Promise.resolve(DISCOVERED),
  egress: EgressGuard = allowAnyEgress,
) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role , mustChangePassword: false };
  await app.register((instance) => {
    targetRoutes({
      resolver: () => Promise.resolve(ctx),
      kek: randomBytes(32),
      store: () => ({ ...STORE, ...over }),
      probe,
      egress,
    })(instance);
    return Promise.resolve();
  });
  return app;
}

const CREATE_PAYLOAD = {
  name: "prod-db",
  engine: "postgres",
  host: "db.internal",
  port: 5432,
  username: "backup",
  password: "s3cret-pw",
  tls: true,
  scope: { databases: ["app"], schemas: [], collections: [] },
};

describe("targets — credential is write-only", () => {
  it("never returns the credential on create", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/targets", payload: CREATE_PAYLOAD });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("s3cret-pw");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });

  it("never returns the credential on read", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/targets/t1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("WRAPPED-DEK");
    expect(res.body).not.toContain("CIPHERTEXT");
    const parsed = JSON.parse(res.body) as { host: string };
    expect(parsed.host).toBe("db.internal");
    await app.close();
  });

  it("never returns the credential when listing", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/targets" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });

  it("refuses target creation for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "POST", url: "/targets", payload: CREATE_PAYLOAD });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // M3: an empty-string db name is never a valid scope entry (a [""] scope is ambiguous downstream —
  // resolveVerifyPlan/originDatabaseFor treat it as unscoped). Reject it at the border so it is not
  // storable in the first place.
  it("rejects a scope containing an empty database name (400)", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...CREATE_PAYLOAD, scope: { databases: [""], schemas: [], collections: [] } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("never returns the credential on update", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "PATCH",
      url: "/targets/t1",
      payload: { password: "rotated-pw" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("rotated-pw");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });
});

describe("PATCH /targets/:id", () => {
  // The whole reason a target needs editing: rotating the credential. Omitting the password is how
  // you edit everything else without having to re-supply a secret the UI can never read back.
  it("re-encrypts the credential only when a password is supplied", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = await appWith("operator", {
      update: (_id, data) => {
        seen.push(data as unknown as Record<string, unknown>);
        return Promise.resolve(RECORD);
      },
    });

    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { host: "db2.internal" } });
    expect(seen[0]).not.toHaveProperty("encryptedCredential");
    expect(seen[0]).toMatchObject({ host: "db2.internal" });

    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { password: "rotated-pw" } });
    expect(seen[1]).toHaveProperty("encryptedCredential");
    expect(JSON.stringify(seen[1])).not.toContain("rotated-pw");
    await app.close();
  });

  // A target's engine decides its dump/restore descriptors and its capability matrix. Existing
  // artifacts already record the engine they were taken with; letting it change would make every
  // one of them describe a database that no longer exists at that address.
  it("refuses to change the engine", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "PATCH",
      url: "/targets/t1",
      payload: { engine: "mysql" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an empty patch rather than reporting a no-op as success", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "PATCH", url: "/targets/t1", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an id outside the caller's organization", async () => {
    const app = await appWith("operator", { update: () => Promise.resolve(null) });
    const res = await app.inject({ method: "PATCH", url: "/targets/nope", payload: { port: 5433 } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a target edit for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "PATCH", url: "/targets/t1", payload: { port: 5433 } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /targets/:id", () => {
  it("deletes a target nothing references", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "DELETE", url: "/targets/t1" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  // A policy points at exactly one target. Deleting it out from under a live policy would leave a
  // schedule that can never run again — and the DB's own restrict would surface as a 500 instead
  // of something the operator can act on.
  it("refuses with 409 and a reason while a policy still references it", async () => {
    const app = await appWith("operator", {
      remove: () => Promise.resolve({ ok: false, reason: "2 policies still reference this target" }),
    });
    const res = await app.inject({ method: "DELETE", url: "/targets/t1" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("policies") });
    await app.close();
  });

  it("refuses a target delete for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "DELETE", url: "/targets/t1" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("targets — the recorded probe travels to the client", () => {
  it("exposes the last probe, which is what the setup checklist reads", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/targets" });
    const [first] = res.json() as { lastProbeOk: boolean | null; lastProbeAt: string | null }[];
    expect(first?.lastProbeOk).toBe(true);
    expect(first?.lastProbeAt).toBe("2026-09-03T12:00:00.000Z");
    await app.close();
  });

  it("still never returns the credential alongside it", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/targets" });
    expect(res.body).not.toContain("WRAPPED-DEK");
    expect(res.body).not.toContain("encryptedCredential");
    await app.close();
  });
});

// On a real deployment an unscoped postgres target dumped `postgres` — the maintenance database —
// while `acme_finance`, 9.4 GB, sat beside it. The dump-time guard (worker-wiring) is the second
// lock; this is the first, and the cheaper one: a target that cannot back up what it means cannot
// be created.
describe("scopeProblem", () => {
  const scope = (...databases: string[]) => ({ databases });

  it("requires exactly one database for postgres, and says why", () => {
    expect(scopeProblem("postgres", scope())).toMatch(/exactly one database/);
    expect(scopeProblem("postgres", scope())).toMatch(/maintenance database/);
    expect(scopeProblem("postgres", scope("a", "b"))).toMatch(/one target per database/);
    expect(scopeProblem("postgres", scope("acme_finance"))).toBeNull();
  });

  it("lets a mongodb target name none (whole instance) or one, never several", () => {
    expect(scopeProblem("mongodb", scope())).toBeNull();
    expect(scopeProblem("mongodb", scope("shop"))).toBeNull();
    expect(scopeProblem("mongodb", scope("shop", "billing"))).toMatch(/at most one/);
  });

  it("leaves mysql and mariadb alone — their dump copies everything the probe finds", () => {
    for (const engine of ["mysql", "mariadb"] as const) {
      expect(scopeProblem(engine, scope())).toBeNull();
      expect(scopeProblem(engine, scope("a", "b", "c"))).toBeNull();
    }
  });
});

describe("POST /targets enforces the scope rule at the border", () => {
  it("refuses an unscoped postgres target with the reason in the body", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...CREATE_PAYLOAD, scope: { databases: [], schemas: [], collections: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/exactly one database/);
    await app.close();
  });

  it("refuses a postgres target naming two databases", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...CREATE_PAYLOAD, scope: { databases: ["a", "b"], schemas: [], collections: [] } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts an unscoped mongodb target, which is the whole-instance form a replica set needs", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...CREATE_PAYLOAD, engine: "mongodb", scope: { databases: [], schemas: [], collections: [] } },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe("PATCH /targets/:id applies the same rule, reading the engine off the row", () => {
  it("refuses emptying a postgres target's scope", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "PATCH",
      url: "/targets/t1",
      payload: { scope: { databases: [], schemas: [], collections: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/exactly one database/);
    await app.close();
  });

  it("accepts a scope of one for postgres", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "PATCH",
      url: "/targets/t1",
      payload: { scope: { databases: ["acme_finance"], schemas: [], collections: [] } },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("does not consult the row when the scope is not being changed", async () => {
    let gets = 0;
    const app = await appWith("operator", {
      get: () => {
        gets += 1;
        return Promise.resolve(RECORD);
      },
    });
    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { name: "renamed" } });
    expect(gets).toBe(0);
    await app.close();
  });
});

describe("POST /targets/discover", () => {
  const CONNECTION = {
    engine: "postgres",
    host: "db.internal",
    port: 5432,
    username: "backup",
    password: "s3cret-pw",
    tls: true,
  };

  it("reports what the server holds, by name and size, without saving anything", async () => {
    let created = 0;
    const app = await appWith("operator", {
      create: () => {
        created += 1;
        return Promise.resolve(RECORD);
      },
    });
    const res = await app.inject({ method: "POST", url: "/targets/discover", payload: CONNECTION });

    expect(res.statusCode).toBe(200);
    expect(res.json<TestConnectionResult>().databases.map((d) => d.name)).toEqual([
      "acme_finance",
      "postgres",
    ]);
    expect(created).toBe(0);
    await app.close();
  });

  it("probes through the engine's maintenance database, exactly as the backup's own probe would", async () => {
    let seen: ProbeTarget | undefined;
    const app = await appWith("operator", {}, (target) => {
      seen = target;
      return Promise.resolve(DISCOVERED);
    });
    await app.inject({ method: "POST", url: "/targets/discover", payload: CONNECTION });

    // An empty scope is what makes the probe connect to `postgres` and list everything. A scoped
    // probe would connect to that one database and, for the purpose of discovery, prove less.
    expect(seen?.databases).toEqual([]);
    expect(seen?.password).toBe("s3cret-pw");
    await app.close();
  });

  it("never echoes the password", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/targets/discover", payload: CONNECTION });
    expect(res.body).not.toContain("s3cret-pw");
    await app.close();
  });

  it("is operator+ — a viewer cannot open connections with arbitrary credentials", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "POST", url: "/targets/discover", payload: CONNECTION });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a body that is not a connection", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/targets/discover", payload: { host: "x" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// The CA certificate is what makes TLS verified. It is public — stored in clear and returned — so
// what the border checks is that it IS certificates, and nothing else: the likeliest wrong paste
// is the private key that sits beside a server's certificate, and this column goes to every viewer.
describe("parseTlsCaCert", () => {
  it("accepts one certificate, and a bundle of several, and stores only the certificates", () => {
    expect(parseTlsCaCert(CA_PEM)).toEqual({ ok: true, pem: CA_PEM });
    const bundle = parseTlsCaCert(`subject=CN = en02\n${CA_PEM}\nissuer=CN = en02\n${CA_PEM}`);
    expect(bundle.ok).toBe(true);
    if (bundle.ok) {
      expect(bundle.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
      expect(bundle.pem).not.toContain("subject=");
    }
  });

  it("refuses anything that is not a certificate, a private key above all", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n";
    expect(parseTlsCaCert(`${CA_PEM}${key}`)).toMatchObject({ ok: false, reason: expect.stringMatching(/private key/) });
    expect(parseTlsCaCert("not a certificate")).toMatchObject({ ok: false });
    expect(parseTlsCaCert("")).toMatchObject({ ok: false });
  });

  it("refuses a certificate block that does not parse — a truncated paste is caught now, not at backup time", () => {
    const truncated = CA_PEM.replace(/^MIID.*$/m, "MIIDtruncated");
    expect(parseTlsCaCert(truncated)).toMatchObject({ ok: false, reason: "certificate 1 of 1 could not be read" });
  });
});

describe("targets — the CA certificate", () => {
  interface RefusedBody {
    error: string;
    field?: string;
    detail?: string;
  }

  it("stores a CA on create and returns it — it is public, unlike the password", async () => {
    let stored: CreateTargetData | undefined;
    const app = await appWith("operator", {
      create: (data) => {
        stored = data;
        return Promise.resolve({ ...RECORD, tlsCaCert: data.tlsCaCert });
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...CREATE_PAYLOAD, tlsCaCert: CA_PEM },
    });
    expect(res.statusCode).toBe(201);
    expect(stored?.tlsCaCert).toBe(CA_PEM);
    expect(res.json<{ tlsCaCert: string | null }>().tlsCaCert).toBe(CA_PEM);
    await app.close();
  });

  it("stores null when none is given, which is TLS required and unverified", async () => {
    let stored: CreateTargetData | undefined;
    const app = await appWith("operator", {
      create: (data) => {
        stored = data;
        return Promise.resolve(RECORD);
      },
    });
    await app.inject({ method: "POST", url: "/targets", payload: CREATE_PAYLOAD });
    expect(stored?.tlsCaCert).toBeNull();
    await app.close();
  });

  it("returns it on read, null when there is none", async () => {
    const app = await appWith("viewer", { get: () => Promise.resolve({ ...RECORD, tlsCaCert: CA_PEM }) });
    const res = await app.inject({ method: "GET", url: "/targets/t1" });
    expect(res.json<{ tlsCaCert: string | null }>().tlsCaCert).toBe(CA_PEM);
    const list = await app.inject({ method: "GET", url: "/targets" });
    expect(list.json<Array<{ tlsCaCert: string | null }>>()[0]?.tlsCaCert).toBeNull();
    await app.close();
  });

  it("refuses something that is not a certificate with 400, naming the field", async () => {
    const app = await appWith("operator");
    for (const url of ["/targets", "/targets/discover"]) {
      const payload =
        url === "/targets"
          ? { ...CREATE_PAYLOAD, tlsCaCert: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----" }
          : { engine: "postgres", host: "h", port: 5432, username: "u", password: "p", tlsCaCert: "nope" };
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<RefusedBody>().field, url).toBe("tlsCaCert");
      expect(res.json<RefusedBody>().detail, url).toMatch(/^the CA certificate /);
    }
    await app.close();
  });

  it("refuses a bundle larger than the cap, naming the field", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...CREATE_PAYLOAD, tlsCaCert: CA_PEM.repeat(Math.ceil(TLS_CA_CERT_MAX_BYTES / CA_PEM.length) + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<RefusedBody>()).toMatchObject({ field: "tlsCaCert", detail: expect.stringMatching(/KiB/) });
    await app.close();
  });

  // A CA with TLS off would read as verification the connection is not doing.
  it("refuses a CA sent with tls: false, on create and on discover", async () => {
    const app = await appWith("operator");
    for (const [url, payload] of [
      ["/targets", { ...CREATE_PAYLOAD, tls: false, tlsCaCert: CA_PEM }],
      ["/targets/discover", { engine: "postgres", host: "h", port: 5432, username: "u", password: "p", tls: false, tlsCaCert: CA_PEM }],
    ] as const) {
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<RefusedBody>(), url).toMatchObject({ field: "tlsCaCert", detail: expect.stringMatching(/only with tls: true/) });
    }
    await app.close();
  });

  it("PATCH: a PEM replaces, null clears, and absence keeps", async () => {
    const seen: UpdateTargetData[] = [];
    const app = await appWith("operator", {
      update: (_id, data) => {
        seen.push(data);
        return Promise.resolve(RECORD);
      },
    });
    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { tlsCaCert: CA_PEM } });
    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { tlsCaCert: null } });
    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { host: "db2.internal" } });
    expect(seen[0]?.tlsCaCert).toBe(CA_PEM);
    expect(seen[1]).toHaveProperty("tlsCaCert", null);
    expect(seen[2]).not.toHaveProperty("tlsCaCert");
    await app.close();
  });

  it("PATCH: a CA is judged against the row's own tls when the patch does not set it", async () => {
    const app = await appWith("operator", { get: () => Promise.resolve({ ...RECORD, tls: false }) });
    const res = await app.inject({ method: "PATCH", url: "/targets/t1", payload: { tlsCaCert: CA_PEM } });
    expect(res.statusCode).toBe(400);
    expect(res.json<RefusedBody>()).toMatchObject({ field: "tlsCaCert", detail: expect.stringMatching(/only with tls: true/) });
    // Turning TLS on in the same patch is the fix, and it is accepted.
    const fixed = await app.inject({
      method: "PATCH",
      url: "/targets/t1",
      payload: { tls: true, tlsCaCert: CA_PEM },
    });
    expect(fixed.statusCode).toBe(200);
    await app.close();
  });

  it("PATCH: refuses a malformed CA with 400, naming the field", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "PATCH", url: "/targets/t1", payload: { tlsCaCert: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json<RefusedBody>().field).toBe("tlsCaCert");
    await app.close();
  });

  it("discover connects with the CA, so the pasted certificate is proved before anything is saved", async () => {
    let seen: ProbeTarget | undefined;
    const app = await appWith("operator", {}, (target) => {
      seen = target;
      return Promise.resolve(DISCOVERED);
    });
    await app.inject({
      method: "POST",
      url: "/targets/discover",
      payload: { engine: "postgres", host: "h", port: 5432, username: "u", password: "p", tlsCaCert: CA_PEM },
    });
    expect(seen?.tlsCaCert).toBe(CA_PEM);
    expect(seen?.tls).toBe(true);
    await app.close();
  });
});

describe("a target names an address this server will actually dial", () => {
  const VALID = {
    name: "shop",
    engine: "postgres",
    host: "db",
    port: 5432,
    username: "backup",
    password: "pw",
    tls: false,
    scope: { databases: ["shop"], schemas: [], collections: [] },
  };

  it("refuses a denied host on create with a 400 that names the field", async () => {
    const app = await appWith("operator", {}, undefined, refuseAnyEgress);
    const res = await app.inject({ method: "POST", url: "/targets", payload: VALID });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid target", field: "host", detail: REFUSAL });
  });

  it("refuses a PATCH that moves the address, judged on the pair the row ends up with", async () => {
    // A patch of `port` alone still moves the address. Judging only the fields present would let
    // `{"port": 2375}` past on a row whose host is already the socket proxy's.
    const app = await appWith("operator", {}, undefined, refuseAnyEgress);
    const res = await app.inject({ method: "PATCH", url: "/targets/t1", payload: { port: 2375 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid target update", field: "host" });
  });

  it("refuses a denied host on /targets/discover, as a rejected request and not a probe failure", async () => {
    // A ProbeFailureCode would say the host is down. It is not: this server declined to look.
    const probe = vi.fn(() => Promise.reject(new EgressRefusedError("host", REFUSAL)));
    const app = await appWith("operator", {}, probe as unknown as (t: ProbeTarget) => Promise<TestConnectionResult>);
    const res = await app.inject({
      method: "POST",
      url: "/targets/discover",
      payload: { engine: "postgres", host: "docker-proxy", port: 2375, username: "u", password: "p" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid connection", field: "host", detail: REFUSAL });
  });

  it("creates a target on a private address under the DEFAULT policy, because that is the normal case", async () => {
    // The guard the shipped deployment builds, with nothing configured. A database on 10.0.0.5 is
    // what this product is for; a default that refused it would be a regression dressed as a fix.
    const created: CreateTargetData[] = [];
    const app = await appWith(
      "operator",
      {
        create: (data) => {
          created.push(data);
          return Promise.resolve(RECORD);
        },
      },
      undefined,
      defaultPolicyGuard(),
    );
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...VALID, host: "10.0.0.5" },
    });
    expect(res.statusCode).toBe(201);
    expect(created[0]?.host).toBe("10.0.0.5");
  });

  it("refuses loopback under that same default policy", async () => {
    const app = await appWith("operator", {}, undefined, defaultPolicyGuard());
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...VALID, host: "127.0.0.1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: "host" });
    expect(String(res.json().detail)).toMatch(/loopback/);
  });
});
