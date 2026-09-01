// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Notification plumbing: read the fleet, ask the pure evaluator what changed, deliver, remember.
//
// It reads COMMITTED state after the fact and is not in any job's path, which is the property that
// matters: a notification failing must never fail a backup.

import { cronEvaluator } from "../scheduler/wiring.js";
import type { PrismaClient } from "../db.js";
import { readCredential, type CredentialAuditSink } from "../crypto/credential-access.js";
import { evaluateNotifications, type DeliveredState, type FleetSnapshot } from "./evaluate.js";
import { deliverEmail, type SmtpDeps } from "./smtp.js";
import { deliverWebhook } from "./webhook.js";

export interface NotificationDeps {
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
          // Dispatch on the discriminator, and read only the half that belongs to it. The columns
          // are nullable because one row is one kind; a channel missing the fields its own kind
          // needs is a broken row, and saying so beats sending nothing and calling it delivered.
          if (channel.kind === "SMTP") {
            const { smtpHost, smtpPort, smtpUsername, encryptedSmtpPassword, fromAddress } =
              channel;
            if (
              smtpHost === null ||
              smtpPort === null ||
              smtpUsername === null ||
              encryptedSmtpPassword === null ||
              fromAddress === null ||
              channel.toAddresses.length === 0
            ) {
              throw new Error(
                "SMTP channel is missing host, port, credentials, sender or recipients",
              );
            }
            await deliverEmail(
              deps.smtp,
              {
                host: smtpHost,
                port: smtpPort,
                username: smtpUsername,
                password: readCredential(deps, encryptedSmtpPassword, {
                  organizationId: channel.organizationId,
                  resource: "notificationChannel",
                  resourceId: channel.id,
                  purpose: "notification: authenticate to the SMTP relay",
                  correlationId: `notify:${channel.id}`,
                }),
                from: fromAddress,
                to: channel.toAddresses,
              },
              notification,
            );
          } else {
            const { url, encryptedSecret } = channel;
            if (url === null || encryptedSecret === null) {
              throw new Error("webhook channel is missing its url or signing secret");
            }
            await deliverWebhook(
              { fetch: deps.fetch },
              {
                url,
                secret: readCredential(deps, encryptedSecret, {
                  organizationId: channel.organizationId,
                  resource: "notificationChannel",
                  resourceId: channel.id,
                  purpose: "notification: sign the outgoing webhook",
                  correlationId: `notify:${channel.id}`,
                }),
              },
              notification,
            );
          }
          delivered += 1;
        } catch (err) {
          // Recorded, never thrown onward: one unreachable channel must not stop the others, and
          // must not take the scheduler tick down with it. A notifier that is failing needs to be
          // visible, which is what these columns are for.
          const reason = err instanceof Error ? err.message : "notification delivery failed";
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
