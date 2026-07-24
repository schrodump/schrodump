// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { PrismaClient } from "@prisma/client";

// One PrismaClient per process. Route handlers never touch this directly — they receive an
// organization-scoped client (see data/scope.ts).
export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

// A dedicated PrismaClient pinned to a SINGLE physical connection (`connection_limit=1`), used
// ONLY for session-level advisory locks. pg_advisory_lock/unlock must run on the same connection
// for the whole hold; the shared HTTP client pools freely and could hand tryLock and unlock
// different connections, stranding the session lock. This one must NOT serve API/drain queries —
// a 3h backup running under the lock would otherwise block every query behind its lone connection.
export function createAdvisoryLockPrismaClient(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", "1");
  return new PrismaClient({ datasourceUrl: url.toString() });
}

export type { PrismaClient };
