// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import type { Auth } from "../auth/auth.js";
import type { Env } from "../env.js";
import type { SetupDeps } from "../routes/setup.js";
import type { BootstrapDeps } from "./bootstrap.js";

// Real dependency wiring for the bootstrap logic and the /setup route. The pure logic is tested
// with mocks; this wiring is exercised by the gated integration tests.
async function createAdminUser(
  prisma: PrismaClient,
  auth: Auth,
  input: { email: string; password: string },
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
    data: { mustChangePassword: true },
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
    createAdmin: (input) => createAdminUser(prisma, auth, input),
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
      await createAdminUser(prisma, auth, { email, password });
    },
    now: () => new Date(),
  };
}
