// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import type { Auth } from "../auth/auth.js";
import type { Env } from "../env.js";
import type { SetupDeps } from "../routes/setup.js";
import type { BootstrapDeps } from "./bootstrap.js";

// Real dependency wiring for the bootstrap logic and the /setup route. The pure logic is tested
// with mocks; this wiring is exercised by the gated integration tests.
// `mustChangePassword` is a PARAMETER, not a constant, and the distinction is the whole point of
// the flag. It exists because a password that came from SCHRODUMP_ADMIN_PASSWORD is readable with
// `docker inspect` by anyone who can reach the host — so the account is provisioned already owing a
// rotation. An admin created through the one-time setup link chose their own password, in a form,
// over a value that never touched the environment. Flagging them too forced the operator to
// immediately replace a password they had just picked, behind a screen that names
// SCHRODUMP_ADMIN_PASSWORD and `docker inspect` as the reason — neither of which is true on that
// path. apps/web/CLAUDE.md already says why that is worse than nothing: "change your password"
// without a reason is bureaucracy, and the person picks something equally careless.
async function createAdminUser(
  prisma: PrismaClient,
  auth: Auth,
  input: { email: string; password: string },
  mustChangePassword: boolean,
): Promise<void> {
  const org = await prisma.organization.create({
    data: { name: "Default", slug: "default", hidden: true },
  });
  // Better-Auth hashes the password and creates the User + Account.
  await auth.api.signUpEmail({
    body: { email: input.email, password: input.password, name: "Admin" },
  });
  const user = await prisma.user.update({
    where: { email: input.email },
    data: { mustChangePassword },
  });
  await prisma.membership.create({
    data: { organizationId: org.id, userId: user.id, role: "admin" },
  });
}

export interface BootstrapLog {
  info(obj: Record<string, unknown>, msg: string): void;
}

export function createBootstrapDeps(
  prisma: PrismaClient,
  auth: Auth,
  env: Env,
  log: BootstrapLog,
): BootstrapDeps {
  return {
    userCount: () => prisma.user.count(),
    // The environment path: the password is in the process environment, so it owes a rotation.
    createAdmin: (input) => createAdminUser(prisma, auth, input, true),
    createSetupToken: async (input) => {
      await prisma.setupToken.create({ data: input });
    },
    now: () => new Date(),
    setupUrl: (token) => `${env.SCHRODUMP_URL}/setup?token=${token}`,
    log,
  };
}

export function createSetupDeps(prisma: PrismaClient, auth: Auth): SetupDeps {
  return {
    userExists: async () => (await prisma.user.count()) > 0,
    findSetupToken: (tokenHash) => prisma.setupToken.findUnique({ where: { tokenHash } }),
    consumeAndCreateAdmin: async ({ tokenHash, email, password }) => {
      await prisma.setupToken.update({ where: { tokenHash }, data: { consumedAt: new Date() } });
      // The setup-link path: the operator chose this password themselves, in a form. Nothing
      // about it is exposed, so there is nothing to rotate.
      await createAdminUser(prisma, auth, { email, password }, false);
    },
    now: () => new Date(),
  };
}
