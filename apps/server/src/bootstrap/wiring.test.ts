// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Which admin owes a password rotation, and which does not.
//
// Both paths went through one createAdminUser that set mustChangePassword unconditionally, so an
// operator following the documented happy path — leave SCHRODUMP_ADMIN_* unset, open the one-time
// setup link, choose a password — was immediately forced to replace the password they had just
// chosen, behind a screen naming SCHRODUMP_ADMIN_PASSWORD and `docker inspect` as the reason.
// Neither is true on that path.
//
// The defect was in the WIRING, not the flag: the routes and the gate were both correct. So this
// tests the callers, with fakes, because that is where the wrong literal was.

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { Auth } from "../auth/auth.js";
import type { Env } from "../env.js";
import { createBootstrapDeps, createSetupDeps } from "./wiring.js";

interface Recorded {
  mustChangePassword?: boolean;
}

function fakes(opts: { userAlreadyExists?: boolean } = {}) {
  const updates: Recorded[] = [];
  const calls: string[] = [];
  const prisma = {
    organization: {
      upsert: () => {
        calls.push("organization.upsert");
        return Promise.resolve({ id: "org-1" });
      },
    },
    user: {
      findUnique: () =>
        Promise.resolve(opts.userAlreadyExists === true ? { id: "user-1" } : null),
      update: ({ data }: { data: Recorded }) => {
        updates.push(data);
        return Promise.resolve({ id: "user-1" });
      },
      count: () => Promise.resolve(0),
    },
    membership: {
      upsert: () => {
        calls.push("membership.upsert");
        return Promise.resolve({});
      },
      findFirst: () => Promise.resolve(null),
    },
    setupToken: {
      update: () => {
        calls.push("setupToken.update");
        return Promise.resolve({});
      },
      findUnique: () => Promise.resolve(null),
    },
  } as unknown as PrismaClient;
  const auth = {
    api: {
      signUpEmail: () => {
        calls.push("signUpEmail");
        return Promise.resolve({});
      },
    },
  } as unknown as Auth;
  return { updates, calls, prisma, auth };
}

const ENV = { SCHRODUMP_URL: "http://localhost:8080" } as unknown as Env;
const LOG = { info: () => undefined };

describe("admin creation and the rotation flag", () => {
  it("flags the environment-provisioned admin, whose password is readable with docker inspect", async () => {
    const { updates, prisma, auth } = fakes();

    await createBootstrapDeps(prisma, auth, ENV, LOG).createAdmin({
      email: "a@example.com",
      password: "from-the-environment",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.mustChangePassword).toBe(true);
  });

  it("does NOT flag the admin created through the setup link, who chose their own password", async () => {
    const { updates, prisma, auth } = fakes();

    await createSetupDeps(prisma, auth).consumeAndCreateAdmin({
      tokenHash: "hash",
      email: "a@example.com",
      password: "chosen-in-the-form",
    });

    expect(updates).toHaveLength(1);
    // The rotation gate refuses EVERY route while this stands, so flagging here made the
    // documented happy path start by demanding the operator undo the step they had just done.
    expect(updates[0]?.mustChangePassword).toBe(false);
  });

  // Creation is three writes that cannot share a transaction — Better-Auth writes the User and the
  // Account through its own adapter. A failure between them used to leave the organization behind,
  // and every retry then died on the slug's unique constraint with the setup token already spent:
  // a deployment with no administrator and no way to make one.
  it("finishes a half-done bootstrap instead of dying on what the first attempt wrote", async () => {
    const { updates, calls, prisma, auth } = fakes({ userAlreadyExists: true });

    await createSetupDeps(prisma, auth).consumeAndCreateAdmin({
      tokenHash: "hash",
      email: "a@example.com",
      password: "chosen-in-the-form",
    });

    // The address is already registered, so sign-up is skipped: asking Better-Auth again answers
    // "email in use" and strands the deployment.
    expect(calls).not.toContain("signUpEmail");
    expect(calls).toContain("organization.upsert");
    expect(calls).toContain("membership.upsert");
    expect(updates).toHaveLength(1);
  });

  // The token is spent only once the admin is real. Spending it first burned the one link the
  // deployment had on any failure in creation, and the next boot issues a token only when there is
  // no admin — which there still was not.
  it("spends the setup token after the administrator exists, not before", async () => {
    const { calls, prisma, auth } = fakes();

    await createSetupDeps(prisma, auth).consumeAndCreateAdmin({
      tokenHash: "hash",
      email: "a@example.com",
      password: "chosen-in-the-form",
    });

    expect(calls.indexOf("setupToken.update")).toBeGreaterThan(calls.indexOf("membership.upsert"));
  });
});
