// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = { DATABASE_URL: "postgres://x", SCHRODUMP_KEK: "k" };

describe("loadEnv worker config", () => {
  it("applies defaults when the worker vars are absent", () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.SCHRODUMP_SCRATCH_PATH).toBeUndefined();
    expect(env.SCHRODUMP_SCRATCH_MAX_BYTES).toBe(107374182400);
    expect(env.SCHRODUMP_MAX_CONCURRENT_STAGED).toBe(2);
    expect(env.SCHRODUMP_EXECUTOR_NETWORK).toBe("schrodump_targets");
    expect(env.WORKER_POLL_MS).toBe(2000);
    expect(env.SCHRODUMP_SCHEDULER_TICK_MS).toBe(30000);
    expect(env.SCHRODUMP_SHUTDOWN_GRACE_MS).toBe(8000);
  });

  it("coerces the numeric vars", () => {
    const env = loadEnv({
      ...base,
      SCHRODUMP_SCRATCH_PATH: "/scratch",
      SCHRODUMP_SCRATCH_MAX_BYTES: "1024",
      SCHRODUMP_MAX_CONCURRENT_STAGED: "4",
      WORKER_POLL_MS: "500",
      SCHRODUMP_SCHEDULER_TICK_MS: "15000",
      SCHRODUMP_SHUTDOWN_GRACE_MS: "5000",
    } as NodeJS.ProcessEnv);
    expect(env.SCHRODUMP_SCRATCH_PATH).toBe("/scratch");
    expect(env.SCHRODUMP_SCRATCH_MAX_BYTES).toBe(1024);
    expect(env.SCHRODUMP_MAX_CONCURRENT_STAGED).toBe(4);
    expect(env.WORKER_POLL_MS).toBe(500);
    expect(env.SCHRODUMP_SCHEDULER_TICK_MS).toBe(15000);
    expect(env.SCHRODUMP_SHUTDOWN_GRACE_MS).toBe(5000);
  });

  it("rejects SCHRODUMP_MAX_CONCURRENT_STAGED below 1", () => {
    expect(() =>
      loadEnv({ ...base, SCHRODUMP_MAX_CONCURRENT_STAGED: "0" } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("accepts SCHRODUMP_MAX_CONCURRENT_STAGED of 1", () => {
    const env = loadEnv({ ...base, SCHRODUMP_MAX_CONCURRENT_STAGED: "1" } as NodeJS.ProcessEnv);
    expect(env.SCHRODUMP_MAX_CONCURRENT_STAGED).toBe(1);
  });
});

// SC-01. The zone every cron is read in. A name the runtime does not know used to be impossible to
// set at all; now that it can be, a typo must stop the boot and say which variable, rather than
// reach cron-parser and throw on every scheduler tick.
describe("SCHRODUMP_TZ", () => {
  it("defaults to UTC, which is what every deployment ran on before it existed", () => {
    expect(loadEnv({ ...base } as NodeJS.ProcessEnv).SCHRODUMP_TZ).toBe("UTC");
  });

  it("takes an IANA name, in its canonical spelling", () => {
    expect(loadEnv({ ...base, SCHRODUMP_TZ: "America/Sao_Paulo" } as NodeJS.ProcessEnv).SCHRODUMP_TZ).toBe(
      "America/Sao_Paulo",
    );
    expect(loadEnv({ ...base, SCHRODUMP_TZ: "america/sao_paulo" } as NodeJS.ProcessEnv).SCHRODUMP_TZ).toBe(
      "America/Sao_Paulo",
    );
  });

  it.each(["Mars/Olympus_Mons", "", "+03:00", "-0300"])("refuses %j and names the variable", (value) => {
    expect(() => loadEnv({ ...base, SCHRODUMP_TZ: value } as NodeJS.ProcessEnv)).toThrow(/SCHRODUMP_TZ/);
  });
});

describe("SCHRODUMP_ADMIN_PASSWORD floor", () => {
  const base = {
    DATABASE_URL: "postgresql://x",
    SCHRODUMP_KEK: "kek",
  };

  // The bootstrap admin is the account with every permission in the deployment, provisioned from a
  // value that sits in .env and shows up in `docker inspect`. Eight characters was Better-Auth's
  // default; twelve is the floor the rotation form already asks for, and the two must agree or the
  // form is a suggestion rather than a control.
  it("refuses a password below the server's own minimum", () => {
    expect(() => loadEnv({ ...base, SCHRODUMP_ADMIN_PASSWORD: "short11chars" .slice(0, 11) })).toThrow();
  });

  it("accepts one at the floor", () => {
    expect(loadEnv({ ...base, SCHRODUMP_ADMIN_PASSWORD: "twelvechars1" }).SCHRODUMP_ADMIN_PASSWORD).toBe(
      "twelvechars1",
    );
  });

  // Absent is not the same as invalid: leaving it out is how an operator opts into the one-time
  // setup link instead, and that path must keep working.
  it("still allows it to be absent entirely", () => {
    expect(loadEnv(base).SCHRODUMP_ADMIN_PASSWORD).toBeUndefined();
  });
});
