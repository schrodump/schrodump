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
  // Every step is idempotent, because the three of them cannot share one transaction: Better-Auth
  // writes the User and Account through its own adapter. A failure between them used to leave the
  // organization behind, and the retry then died on the slug's unique constraint — a 500 on every
  // subsequent attempt, with the setup token already spent. Now a half-finished bootstrap simply
  // finishes on the next attempt.
  const org = await prisma.organization.upsert({
    where: { slug: "default" },
    update: {},
    create: { name: "Default", slug: "default", hidden: true },
  });
  // Better-Auth hashes the password and creates the User + Account. Skipped when the address is
  // already here, which means a previous attempt got this far; sign-up would answer "email in use"
  // and strand the deployment. Safe only because the public sign-up endpoint is blocked
  // (registerAuthHandler): otherwise a stranger could register the address an admin was about to
  // claim and be handed the membership meant for its owner.
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing === null) {
    await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: "Admin" },
    });
  }
  const user = await prisma.user.update({
    where: { email: input.email },
    data: { mustChangePassword },
  });
  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { role: "admin" },
    create: { organizationId: org.id, userId: user.id, role: "admin" },
  });
}

// One question, asked by the bootstrap and by /setup: does this deployment have an administrator?
function adminExists(prisma: PrismaClient): Promise<boolean> {
  return prisma.membership
    .findFirst({ where: { role: "admin" }, select: { id: true } })
    .then((row) => row !== null);
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
    adminExists: () => adminExists(prisma),
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
    adminExists: () => adminExists(prisma),
    findSetupToken: (tokenHash) => prisma.setupToken.findUnique({ where: { tokenHash } }),
    consumeAndCreateAdmin: async ({ tokenHash, email, password }) => {
      // The setup-link path: the operator chose this password themselves, in a form. Nothing
      // about it is exposed, so there is nothing to rotate.
      //
      // The token is spent AFTER the admin exists. Spending it first meant a failure anywhere in
      // creation burned the one link the deployment had, and the next boot issues a token only
      // when there is no admin — which there still was not. Re-using a token that produced nothing
      // is the lesser risk: it is single-use, 60 minutes old at most, and the window is one failed
      // request wide.
      await createAdminUser(prisma, auth, { email, password }, false);
      await prisma.setupToken.update({ where: { tokenHash }, data: { consumedAt: new Date() } });
    },
    now: () => new Date(),
  };
}
