// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// One self-backup tick: decide whether one is due, and if so run it end to end. Called on a loop
// under its own advisory lock, so at most one replica is ever dumping the metadata database.

import type { PrismaClient } from "@prisma/client";
import { createDockerRunner } from "@schrodump/runner/runner";
import { isSelfBackupDue, runSelfBackup } from "./self-backup.js";
import { createSelfBackupPorts, resolveSelfBackupContext } from "./self-backup-wiring.js";

// An executor dumping a metadata database is bounded generously: it is a small database by the
// standards of the ones this tool exists to back up, but it is also the one whose loss is
// unrecoverable, so a slow dump is preferable to a truncated one.
const SELF_BACKUP_TIMEOUT_MS = 30 * 60 * 1000;

export interface SelfBackupTickDeps {
  prisma: PrismaClient;
  kek: Buffer;
  databaseUrl: string;
  destinationId: string;
  network: string;
  intervalMs: number;
  now: () => Date;
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  signal?: AbortSignal;
}

export async function runScheduledSelfBackup(deps: SelfBackupTickDeps): Promise<boolean> {
  const last = await deps.prisma.selfBackup.findFirst({
    where: { state: "SUCCEEDED" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  if (!isSelfBackupDue(last?.finishedAt ?? null, deps.now(), deps.intervalMs)) return false;

  // The row is created BEFORE the context is resolved, so a misconfiguration — a destination that
  // was deleted, an escrow key that was never generated — lands as a FAILED self-backup an operator
  // can see, rather than as a log line on a server nobody is tailing.
  const row = await deps.prisma.selfBackup.create({
    data: { destinationId: deps.destinationId, state: "RUNNING" },
    select: { id: true },
  });

  let context;
  try {
    context = await resolveSelfBackupContext(deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "self-backup configuration error";
    await deps.prisma.selfBackup.update({
      where: { id: row.id },
      data: { state: "FAILED", reason, finishedAt: deps.now() },
    });
    deps.log.error({ selfBackupId: row.id, reason }, "self-backup could not be configured");
    return true;
  }

  await deps.prisma.selfBackup.update({
    where: { id: row.id },
    data: { organizationId: context.organizationId, keyIds: context.keyIds },
  });

  const ports = createSelfBackupPorts(
    {
      prisma: deps.prisma,
      kek: deps.kek,
      databaseUrl: deps.databaseUrl,
      destinationId: deps.destinationId,
      network: deps.network,
      timeoutMs: SELF_BACKUP_TIMEOUT_MS,
      runner: createDockerRunner(),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
    context,
    row.id,
  );

  const outcome = await runSelfBackup(ports);
  if (outcome.ok) {
    // The row already carries bucketKey/size/checksum — writeManifest persisted them where they
    // were known. Logged as well because the bucket key is where a recovery starts.
    deps.log.info({ selfBackupId: row.id, bucketKey: outcome.bucketKey }, "self-backup succeeded");
  } else {
    deps.log.error({ selfBackupId: row.id }, "self-backup failed");
  }
  return true;
}
