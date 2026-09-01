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

function fakes() {
  const updates: Recorded[] = [];
  const prisma = {
    organization: { create: () => Promise.resolve({ id: "org-1" }) },
    user: {
      update: ({ data }: { data: Recorded }) => {
        updates.push(data);
        return Promise.resolve({ id: "user-1" });
      },
      count: () => Promise.resolve(0),
    },
    membership: { create: () => Promise.resolve({}) },
    setupToken: { update: () => Promise.resolve({}), findUnique: () => Promise.resolve(null) },
  } as unknown as PrismaClient;
  const auth = { api: { signUpEmail: () => Promise.resolve({}) } } as unknown as Auth;
  return { updates, prisma, auth };
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
});
