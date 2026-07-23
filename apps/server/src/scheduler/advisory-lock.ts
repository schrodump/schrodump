// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";

// A Postgres session-level advisory lock. Used instead of an in-process cron so that, across
// replicas, only ONE evaluates the schedule and dispatches jobs — otherwise two replicas fire
// the same job.
export interface AdvisoryLock {
  tryLock(key: bigint): Promise<boolean>;
  unlock(key: bigint): Promise<void>;
}

// Runs `fn` only if the lock is acquired; returns null when another holder has it.
export async function withAdvisoryLock<T>(
  lock: AdvisoryLock,
  key: bigint,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!(await lock.tryLock(key))) return null;
  try {
    return await fn();
  } finally {
    await lock.unlock(key);
  }
}

export function pgAdvisoryLock(prisma: PrismaClient): AdvisoryLock {
  return {
    tryLock: async (key) => {
      const rows = await prisma.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${key}) AS locked
      `;
      return rows[0]?.locked === true;
    },
    unlock: async (key) => {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${key})`;
    },
  };
}
