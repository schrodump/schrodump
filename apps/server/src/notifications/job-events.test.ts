// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { encryptCredential } from "../crypto/envelope.js";
import { runJobEventNotifications } from "./job-events.js";

const KEK = Buffer.alloc(32, 9);
const NOW = new Date("2026-09-10T12:00:00.000Z");

const OPTED_IN = {
  id: "chan-1",
  organizationId: "org-1",
  kind: "WEBHOOK",
  url: "https://hooks.example/x",
  encryptedSecret: JSON.stringify(encryptCredential(KEK, "example-example-example")),
  smtpHost: null,
  smtpPort: null,
  smtpUsername: null,
  encryptedSmtpPassword: null,
  fromAddress: null,
  toAddresses: [],
  deliverJobEvents: true,
};

const EVENT = {
  id: "evt-1",
  organizationId: "org-1",
  jobId: "job-1",
  kind: "BACKUP",
  state: "RUNNING",
  at: NOW,
  deliveredAt: null,
  job: { policyId: "pol-1", policy: { name: "shop-daily" } },
};

function fakePrisma(channels: unknown[], events: unknown[]) {
  const marked: string[] = [];
  const pruned: Record<string, unknown>[] = [];
  const channelUpdates: Record<string, unknown>[] = [];
  return {
    marked,
    pruned,
    channelUpdates,
    client: {
      notificationChannel: {
        findMany: () => Promise.resolve(channels),
        update: ({ data }: { data: Record<string, unknown> }) => {
          channelUpdates.push(data);
          return Promise.resolve(channels[0]);
        },
      },
      jobEvent: {
        findMany: () => Promise.resolve(events),
        updateMany: ({ where }: { where: { id: { in: string[] } } }) => {
          marked.push(...where.id.in);
          return Promise.resolve({ count: where.id.in.length });
        },
        deleteMany: (args: Record<string, unknown>) => {
          pruned.push(args);
          return Promise.resolve({ count: 0 });
        },
      },
    },
  };
}

function depsWith(prisma: ReturnType<typeof fakePrisma>, fetchImpl: typeof fetch) {
  return {
    prisma: prisma.client as never,
    kek: KEK,
    audit: { record: () => undefined },
    now: () => NOW,
    fetch: fetchImpl,
    smtp: { ca: null, createTransport: () => ({ sendMail: () => Promise.resolve({}) }) },
    log: { info: () => undefined, error: () => undefined },
  };
}

describe("runJobEventNotifications", () => {
  it("delivers a transition to a channel that opted in", async () => {
    const prisma = fakePrisma([OPTED_IN], [EVENT]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const drained = await runJobEventNotifications(
      depsWith(prisma, fetchMock as unknown as typeof fetch),
    );

    expect(drained).toBe(1);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body.trigger).toBe("JOB_STATE");
    expect((body.job as Record<string, unknown>).state).toBe("RUNNING");
    // The policy's name is what an operator recognises; the id is what a receiver routes on.
    expect(String(body.summary)).toContain("shop-daily");
  });

  it("delivers nothing to a channel that did not opt in, and still clears the event", async () => {
    // The trigger writes unconditionally. If an unsubscribed deployment never marked events
    // delivered, the table would grow forever behind a feature nobody switched on.
    const prisma = fakePrisma([{ ...OPTED_IN, deliverJobEvents: false }], [EVENT]);
    const fetchMock = vi.fn();
    await runJobEventNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.marked).toEqual(["evt-1"]);
  });

  it("never delivers another organization's job to this organization's channel", async () => {
    const prisma = fakePrisma([OPTED_IN], [{ ...EVENT, organizationId: "org-2" }]);
    const fetchMock = vi.fn();
    await runJobEventNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks an event delivered even when a channel refused it, and records why on the channel", async () => {
    // The same trade-off notificationState makes: otherwise one dead channel replays the whole
    // backlog to the healthy ones on every tick, forever. The failure lands on the channel row,
    // which is the thing the interface already watches.
    const prisma = fakePrisma([OPTED_IN], [EVENT]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await runJobEventNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));

    expect(prisma.marked).toEqual(["evt-1"]);
    expect(String(prisma.channelUpdates[0]?.lastFailure)).toContain("500");
  });

  it("prunes delivered events once they are older than the retention window", async () => {
    const prisma = fakePrisma([OPTED_IN], []);
    await runJobEventNotifications(depsWith(prisma, vi.fn() as unknown as typeof fetch));

    const where = prisma.pruned[0]?.where as { deliveredAt: { lt: Date } };
    expect(where.deliveredAt.lt.getTime()).toBeLessThan(NOW.getTime());
  });
});
