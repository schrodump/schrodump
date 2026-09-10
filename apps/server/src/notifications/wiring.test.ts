// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The seam, which had no test at all.
//
// evaluate.ts is pure and thoroughly covered; the delivery functions are covered; what was never
// exercised is the loop that joins them to the database. That is precisely where the JSON.parse
// bug lived for the whole life of the feature (see secret-envelope.test.ts), and where the next
// one will live if this file stays empty.

import { describe, expect, it, vi } from "vitest";
import { encryptCredential } from "../crypto/envelope.js";
import { runNotifications } from "./wiring.js";

const KEK = Buffer.alloc(32, 3);
const NOW = new Date("2026-09-10T12:00:00.000Z");

function fakePrisma(channel: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    client: {
      organization: { findMany: () => Promise.resolve([{ id: "org-1" }]) },
      notificationChannel: {
        findMany: () => Promise.resolve([channel]),
        update: ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return Promise.resolve(channel);
        },
      },
      // One artifact a verify restored and found unusable: ARTIFACT_FAILED opens on the first
      // evaluation, with no previous snapshot needed.
      artifact: { count: () => Promise.resolve(0), findMany: () => Promise.resolve([{ id: 'a1' }]) },
      backupPolicy: { findMany: () => Promise.resolve([]) },
      backupJob: { findFirst: () => Promise.resolve(null) },
      notificationSnapshot: {
        findUnique: () => Promise.resolve(null),
        upsert: () => Promise.resolve({}),
      },
      notificationState: {
        findMany: () => Promise.resolve([]),
        create: () => Promise.resolve({}),
        deleteMany: () => Promise.resolve({ count: 0 }),
      },
    },
  };
}

const WEBHOOK_ROW = {
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
};

function depsWith(prisma: ReturnType<typeof fakePrisma>, fetchImpl: typeof fetch) {
  return {
    prisma: prisma.client as never,
    kek: KEK,
    audit: { record: () => undefined },
    now: () => NOW,
    fetch: fetchImpl,
    smtp: { ca: null, createTransport: () => ({ sendMail: () => Promise.resolve({}) }) },
    log: { info: () => undefined, error: () => undefined },
    minEvaluationGapMs: 900_000,
  };
}

describe("runNotifications records what happened to the channel", () => {
  it("marks a delivery that arrived, so a channel carrying real traffic is not stuck unobserved", async () => {
    // Without this the ONLY thing that could ever move a channel out of UNOBSERVED was an operator
    // pressing "send a test" — a channel quietly delivering every real alert for a month would
    // still be reported as an open question, which is a lie in the other direction.
    const prisma = fakePrisma(WEBHOOK_ROW);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const delivered = await runNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));

    expect(delivered).toBeGreaterThan(0);
    expect(prisma.updates[0]?.lastSuccessAt).toEqual(NOW);
  });

  it("records the reason when a delivery fails, and does not mark it as arrived", async () => {
    const prisma = fakePrisma(WEBHOOK_ROW);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await runNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));

    expect(prisma.updates[0]?.lastFailure).toContain("500");
    expect(prisma.updates[0]?.lastSuccessAt).toBeUndefined();
  });
});

// The snapshot is the ANCHOR for "the unobserved count is not coming down". It is compared against
// now, and it is rewritten at the end of every tick — so it is always one tick old, and one tick is
// 30 seconds by default while the gap that makes it count is fifteen minutes.
//
// An anchor that moves every time you look at it is not an anchor.
describe("VERIFICATION_BEHIND — the anchor has to be allowed to age", () => {
  it("fires when the unobserved count sits still for longer than the gap", async () => {
    // Twenty minutes of ticks at the default cadence, with five artifacts nobody is verifying and
    // the number never moving. This is the exact condition the trigger exists for: the case the
    // whole product is about, jobs succeeding while nothing is verified.
    let clock = new Date("2026-09-10T12:00:00.000Z").getTime();
    let stored: { at: Date; unobserved: number } | null = null;
    const sent: string[] = [];

    const prisma = {
      organization: { findMany: () => Promise.resolve([{ id: "org-1" }]) },
      notificationChannel: {
        findMany: () => Promise.resolve([WEBHOOK_ROW]),
        update: () => Promise.resolve(WEBHOOK_ROW),
      },
      artifact: { count: () => Promise.resolve(5), findMany: () => Promise.resolve([]) },
      backupPolicy: { findMany: () => Promise.resolve([]) },
      backupJob: { findFirst: () => Promise.resolve(null) },
      notificationSnapshot: {
        findUnique: () => Promise.resolve(stored),
        upsert: ({ create }: { create: { at: Date; unobserved: number } }) => {
          stored = { at: create.at, unobserved: create.unobserved };
          return Promise.resolve({});
        },
      },
      notificationState: {
        findMany: () => Promise.resolve([]),
        create: () => Promise.resolve({}),
        deleteMany: () => Promise.resolve({ count: 0 }),
      },
    };

    const fetchMock = vi.fn(((_url: string, init: RequestInit) => {
      sent.push(String(init.body));
      return Promise.resolve({ ok: true, status: 200 });
    }) as unknown as typeof fetch);

    for (let tick = 0; tick < 40; tick += 1) {
      await runNotifications({
        prisma: prisma as never,
        kek: KEK,
        audit: { record: () => undefined },
        now: () => new Date(clock),
        fetch: fetchMock,
        smtp: { ca: null, createTransport: () => ({ sendMail: () => Promise.resolve({}) }) },
        log: { info: () => undefined, error: () => undefined },
        minEvaluationGapMs: 900_000,
      });
      clock += 30_000;
    }

    expect(sent.some((body) => body.includes("VERIFICATION_BEHIND"))).toBe(true);
  });
});
