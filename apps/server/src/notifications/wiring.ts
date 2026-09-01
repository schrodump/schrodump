// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Notification plumbing: read the fleet, ask the pure evaluator what changed, deliver, remember.
//
// It reads COMMITTED state after the fact and is not in any job's path, which is the property that
// matters: a notification failing must never fail a backup.

import { cronEvaluator } from "../scheduler/wiring.js";
import type { PrismaClient } from "../db.js";
import { decryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import { evaluateNotifications, type DeliveredState, type FleetSnapshot } from "./evaluate.js";
import { deliverWebhook } from "./webhook.js";

export interface NotificationDeps {
  prisma: PrismaClient;
  kek: Buffer;
  now: () => Date;
  fetch: typeof fetch;
  log: {
    info(o: Record<string, unknown>, m: string): void;
    error(o: Record<string, unknown>, m: string): void;
  };
  // The hysteresis is meaningless if two evaluations are seconds apart: a backup is legitimately
  // unobserved between finishing and its chained verify. Below this age the previous snapshot is
  // treated as absent, so "the count did not come down" cannot fire on a healthy backup.
  minEvaluationGapMs: number;
}

// Expected cadence for a policy, as the distance between two consecutive windows. CronEvaluator
// only answers "the window at or before this instant", which is enough: ask for the current one,
// then for the one just before it. Floored at a minute so a pathological expression cannot make the
// quiet-policy deadline effectively zero and alert on every tick.
function expectedIntervalMs(cron: string, now: Date): number {
  const evaluator = cronEvaluator();
  const current = evaluator.currentWindow(cron, now);
  const previous = evaluator.currentWindow(cron, new Date(current.getTime() - 1));
  return Math.max(current.getTime() - previous.getTime(), 60_000);
}

export async function runNotifications(deps: NotificationDeps): Promise<number> {
  const now = deps.now();
  const orgs = await deps.prisma.organization.findMany({ select: { id: true } });
  let delivered = 0;

  for (const org of orgs) {
    const channels = await deps.prisma.notificationChannel.findMany({
      where: { organizationId: org.id, enabled: true },
    });
    if (channels.length === 0) continue;

    const [unobserved, failed, policies, previousRow, deliveredRows] = await Promise.all([
      deps.prisma.artifact.count({ where: { organizationId: org.id, state: "UNOBSERVED" } }),
      deps.prisma.artifact.findMany({
        where: { organizationId: org.id, state: "FAILED" },
        select: { id: true },
      }),
      deps.prisma.backupPolicy.findMany({
        where: { organizationId: org.id, enabled: true },
        select: { id: true, name: true, cron: true },
      }),
      deps.prisma.notificationSnapshot.findUnique({ where: { organizationId: org.id } }),
      deps.prisma.notificationState.findMany({ where: { organizationId: org.id } }),
    ]);

    const policyHealth = await Promise.all(
      policies.map(async (p) => {
        const last = await deps.prisma.backupJob.findFirst({
          where: { organizationId: org.id, policyId: p.id, kind: "BACKUP", state: "SUCCEEDED" },
          orderBy: { finishedAt: "desc" },
          select: { finishedAt: true },
        });
        return {
          id: p.id,
          name: p.name,
          expectedIntervalMs: expectedIntervalMs(p.cron, now),
          lastSucceededAt: last?.finishedAt ?? null,
        };
      }),
    );

    const snapshot: FleetSnapshot = {
      at: now,
      unobserved,
      failedArtifactIds: failed.map((a) => a.id),
      policies: policyHealth,
    };
    // Too-recent previous snapshot is treated as absent — see minEvaluationGapMs.
    const previous =
      previousRow !== null && now.getTime() - previousRow.at.getTime() >= deps.minEvaluationGapMs
        ? { ...snapshot, at: previousRow.at, unobserved: previousRow.unobserved }
        : null;

    const notifications = evaluateNotifications({
      snapshot,
      previous,
      delivered: deliveredRows.map((r): DeliveredState => ({
        trigger: r.trigger as DeliveredState["trigger"],
        key: r.key,
        since: r.since,
      })),
    });

    for (const notification of notifications) {
      for (const channel of channels) {
        try {
          await deliverWebhook(
            { fetch: deps.fetch },
            {
              url: channel.url,
              secret: decryptCredential(
                deps.kek,
                parseEncryptedCredential(channel.encryptedSecret),
              ),
            },
            notification,
          );
          delivered += 1;
        } catch (err) {
          // Recorded, never thrown onward: one unreachable channel must not stop the others, and
          // must not take the scheduler tick down with it. A notifier that is failing needs to be
          // visible, which is what these columns are for.
          const reason = err instanceof Error ? err.message : "webhook delivery failed";
          deps.log.error({ channelId: channel.id, reason }, "notification delivery failed");
          await deps.prisma.notificationChannel.update({
            where: { id: channel.id },
            data: { lastFailureAt: now, lastFailure: reason },
          });
        }
      }

      // State moves whether or not delivery succeeded. Otherwise an unreachable channel turns every
      // tick into a fresh "opened" for the same condition, which is the alert storm this design
      // exists to avoid — and the failure itself is already recorded on the channel.
      if (notification.kind === "opened") {
        await deps.prisma.notificationState.create({
          data: { organizationId: org.id, trigger: notification.trigger, key: notification.key },
        });
      } else {
        await deps.prisma.notificationState.deleteMany({
          where: { organizationId: org.id, trigger: notification.trigger, key: notification.key },
        });
      }
    }

    await deps.prisma.notificationSnapshot.upsert({
      where: { organizationId: org.id },
      create: { organizationId: org.id, at: now, unobserved },
      update: { at: now, unobserved },
    });
  }

  return delivered;
}
