// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { PrismaClient } from "@prisma/client";

// One PrismaClient per process. Route handlers never touch this directly — they receive an
// organization-scoped client (see data/scope.ts).
export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

export type { PrismaClient };
