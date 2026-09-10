// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Draining the job-event outbox.
//
// A database trigger on BackupJob writes a row inside the job's own transaction and returns; this
// reads committed rows on the scheduler tick and delivers them. Delivery is never in a job's path,
// for the reason the whole notifications subsystem is built around: a notification that fails must
// never fail a backup.
//
// This is the opt-in firehose, not the alerting path. evaluate.ts still emits the three fleet
// triggers and knows nothing about jobs — the unit of ALERTING is the fleet. A channel that asked
// for job events gets them here, in addition.

import type { PrismaClient } from "../db.js";
import type { CredentialAuditSink } from "../crypto/credential-access.js";
import { deliverToChannel, type StoredChannel } from "./deliver.js";
import type { SmtpDeps } from "./smtp.js";

// A burst of jobs must not make one tick unbounded. Whatever is left waits for the next pass, and
// the outbox is ordered oldest-first so nothing starves.
export const JOB_EVENT_DRAIN_LIMIT = 200;

// Delivered rows are kept briefly — long enough to answer "did you actually send it?" while
// debugging a receiver — and then collected.
export const JOB_EVENT_RETENTION_MS = 86_400_000;

export interface JobEventDeps {
  prisma: PrismaClient;
  kek: Buffer;
  // Every decryption below is an art. 37 access. See crypto/credential-access.ts.
  audit: CredentialAuditSink;
  now: () => Date;
  fetch: typeof fetch;
  smtp: SmtpDeps;
  log: {
    info(o: Record<string, unknown>, m: string): void;
    error(o: Record<string, unknown>, m: string): void;
  };
}

// The policy's name is what an operator recognises in an inbox; the id is what a receiver routes
// on, and it travels in the structured `job` field rather than in this sentence.
function summaryOf(kind: string, state: string, policyName: string | null): string {
  return policyName === null
    ? `${kind} job is ${state}`
    : `${kind} job for policy "${policyName}" is ${state}`;
}

interface OutboxRow {
  id: string;
  organizationId: string;
  jobId: string;
  kind: string;
  state: string;
  job: { policyId: string | null; policy: { name: string } | null } | null;
}

export async function runJobEventNotifications(deps: JobEventDeps): Promise<number> {
  const now = deps.now();
  const events = (await deps.prisma.jobEvent.findMany({
    where: { deliveredAt: null },
    orderBy: { at: "asc" },
    take: JOB_EVENT_DRAIN_LIMIT,
    include: { job: { select: { policyId: true, policy: { select: { name: true } } } } },
  })) as unknown as OutboxRow[];

  if (events.length > 0) {
    const channels = (await deps.prisma.notificationChannel.findMany({
      where: { enabled: true, deliverJobEvents: true },
    })) as unknown as (StoredChannel & { deliverJobEvents: boolean })[];

    for (const event of events) {
      for (const channel of channels.filter(
        (c) => c.organizationId === event.organizationId && c.deliverJobEvents,
      )) {
        try {
          await deliverToChannel(deps, channel, {
            trigger: "JOB_STATE",
            key: event.jobId,
            kind: "occurred",
            summary: summaryOf(event.kind, event.state, event.job?.policy?.name ?? null),
            job: {
              id: event.jobId,
              kind: event.kind,
              state: event.state,
              policyId: event.job?.policyId ?? null,
            },
          });
        } catch (err) {
          // Recorded on the channel, never thrown onward: one unreachable channel must not stop
          // the others, and a failing notifier has to be visible somewhere the interface reads.
          const reason = err instanceof Error ? err.message : "job event delivery failed";
          deps.log.error({ channelId: channel.id, reason }, "job event delivery failed");
          await deps.prisma.notificationChannel.update({
            where: { id: channel.id },
            data: { lastFailureAt: now, lastFailure: reason },
          });
        }
      }
    }

    // Marked whether or not every channel accepted it — the trade-off notificationState already
    // makes, so one dead channel cannot replay the whole backlog to the healthy ones on every
    // tick, forever. Marked even when NOTHING subscribed: the trigger writes unconditionally, so
    // an unsubscribed deployment would otherwise grow a table behind a feature nobody switched on.
    await deps.prisma.jobEvent.updateMany({
      where: { id: { in: events.map((e) => e.id) } },
      data: { deliveredAt: now },
    });
  }

  await deps.prisma.jobEvent.deleteMany({
    where: { deliveredAt: { lt: new Date(now.getTime() - JOB_EVENT_RETENTION_MS) } },
  });

  return events.length;
}
