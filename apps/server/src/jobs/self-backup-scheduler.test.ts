// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { runScheduledSelfBackup } from "./self-backup-scheduler.js";

const NOW = new Date("2026-09-01T12:00:00Z");
const DAY = 86_400_000;

interface Row {
  id: string;
  state: string;
  reason: string | null;
  finishedAt: Date | null;
  organizationId: string | null;
}

function harness(opts: { lastSucceededAt?: Date; destination?: unknown; keys?: unknown[] } = {}) {
  const rows: Row[] = [];
  const log = { info: vi.fn(), error: vi.fn() };
  const prisma = {
    selfBackup: {
      findFirst: () =>
        Promise.resolve(
          opts.lastSucceededAt === undefined ? null : { finishedAt: opts.lastSucceededAt },
        ),
      create: ({ data }: { data: { destinationId: string } }) => {
        const row: Row = {
          id: `sb-${String(rows.length + 1)}`,
          state: "RUNNING",
          reason: null,
          finishedAt: null,
          organizationId: null,
        };
        rows.push(row);
        void data;
        return Promise.resolve({ id: row.id });
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row !== undefined) Object.assign(row, data);
        return Promise.resolve(row);
      },
    },
    storageDestination: { findUnique: () => Promise.resolve(opts.destination ?? null) },
    encryptionKey: { findMany: () => Promise.resolve(opts.keys ?? []) },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    kek: Buffer.alloc(32),
    databaseUrl: "postgresql://u:p@db:5432/schrodump",
    destinationId: "dest-1",
    network: "schrodump_internal",
    intervalMs: DAY,
    now: () => NOW,
    log,
  };
  return { deps, rows, log };
}

describe("runScheduledSelfBackup", () => {
  it("does nothing when a self-backup succeeded inside the interval", async () => {
    const h = harness({ lastSucceededAt: new Date("2026-09-01T11:00:00Z") });
    expect(await runScheduledSelfBackup(h.deps)).toBe(false);
    expect(h.rows).toHaveLength(0);
  });

  // The behaviour that makes a misconfiguration visible. Without the row, an operator who set
  // SCHRODUMP_SELF_BACKUP_DESTINATION_ID to a destination that was later deleted would see a
  // configured self-backup and no evidence it never ran once.
  it("records a FAILED row when the destination does not exist", async () => {
    const h = harness();
    expect(await runScheduledSelfBackup(h.deps)).toBe(true);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]?.state).toBe("FAILED");
    expect(h.rows[0]?.reason).toMatch(/does not exist/);
    expect(h.rows[0]?.finishedAt).toEqual(NOW);
    expect(h.log.error).toHaveBeenCalled();
  });

  // The decoy guard, end to end: an organization with only an operational key must not produce a
  // self-backup at all. The operational identity lives inside the database being dumped.
  it("records a FAILED row when the organization has no active escrow key", async () => {
    const h = harness({
      destination: { id: "dest-1", organizationId: "org-1" },
      keys: [
        { keyId: "ops", type: "operational", publicRecipient: "age1ops", state: "active" },
        { keyId: "esc", type: "escrow", publicRecipient: "age1esc", state: "retired" },
      ],
    });
    expect(await runScheduledSelfBackup(h.deps)).toBe(true);
    expect(h.rows[0]?.state).toBe("FAILED");
    expect(h.rows[0]?.reason).toMatch(/escrow/);
  });
});
