# Job-event notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a notification channel opt into receiving one delivery per `BackupJob` state
transition, without changing what any existing channel receives.

**Architecture:** An `AFTER INSERT OR UPDATE OF state` trigger on `BackupJob` writes a `JobEvent`
outbox row inside the job's own transaction — the only mechanism that sees `claimNextJob`'s raw-SQL
`PENDING → RUNNING`. A pass on the scheduler tick drains undelivered rows to channels whose
`deliverJobEvents` is true, reusing `deliverToChannel`, then prunes. Delivery stays out of every
job's path.

**Tech Stack:** PostgreSQL trigger + PL/pgSQL, Prisma 6, Fastify 5, Zod 4, Vitest, Next 16/React 19.

**Spec:** `docs/superpowers/specs/2026-09-10-job-event-notifications-design.md`

## Global Constraints

- Every source file begins with the two SPDX lines (`AGPL-3.0-or-later`, `2026 ARIERRAC
  DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA`). Prisma `.sql` migrations do not carry it.
- All identifiers, comments, commit messages and API fields in **English**. pt-BR only in
  `apps/web/src/i18n/messages/pt-BR.ts`.
- Any content change to `README.md` must update `README.pt-BR.md` and `README.es.md` in the same
  commit. This plan does not change any README.
- A UI string added to `en.ts` must be added to `pt-BR.ts` and `es.ts` in the same commit.
- `apps/web` imports no workspace package; domain vocabulary is re-declared in `src/lib/domain.ts`.
- Verify with `pnpm typecheck && pnpm lint && pnpm test` from the root.
- Never run Prettier over touched files — the committed tree is not Prettier-clean.

---

### Task 1: The outbox table and the trigger that fills it

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (add `JobEvent`, add `NotificationChannel.deliverJobEvents`, add the `JobEvent[]` back-relation on `Organization`)
- Create: `apps/server/prisma/migrations/20260910170000_job_event_outbox/migration.sql`
- Test: `apps/server/src/jobs/job-event-trigger.integration.test.ts`

**Interfaces:**
- Produces: table `JobEvent(id, organizationId, jobId, kind, state, at, deliveredAt)`; column
  `NotificationChannel.deliverJobEvents Boolean @default(false)`.

- [ ] **Step 1: Write the failing integration test**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The trigger exists because claimNextJob flips PENDING -> RUNNING in raw SQL, which no Prisma
// hook can observe. That is the case this suite has to prove, not the easy one.
import { describe, expect, it } from "vitest";

const RUN = process.env.SCHRODUMP_TEST_INTEGRATION === "1";

describe.skipIf(!RUN)("the JobEvent trigger", () => {
  it("records the raw-SQL claim, which no application hook can see", async () => {
    const { prisma, organizationId } = await freshDatabase();
    const job = await prisma.backupJob.create({
      data: { organizationId, kind: "BACKUP", state: "PENDING", correlationId: "c1" },
    });
    await claimNextJob(prisma);

    const events = await prisma.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { at: "asc" },
    });
    expect(events.map((e) => e.state)).toEqual(["PENDING", "RUNNING"]);
  });

  it("does not fire when a column other than state changes", async () => {
    const { prisma, organizationId } = await freshDatabase();
    const job = await prisma.backupJob.create({
      data: { organizationId, kind: "BACKUP", state: "PENDING", correlationId: "c1" },
    });
    await prisma.backupJob.update({ where: { id: job.id }, data: { reason: "noted" } });
    expect(await prisma.jobEvent.count({ where: { jobId: job.id } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/server && SCHRODUMP_TEST_INTEGRATION=1 npx vitest run src/jobs/job-event-trigger.integration.test.ts`
Expected: FAIL — `prisma.jobEvent` is not a property.

- [ ] **Step 3: Add the models**

In `apps/server/prisma/schema.prisma`, add to `NotificationChannel`:

```prisma
  // Opt-in firehose: one delivery per BackupJob state transition, on top of the three fleet
  // triggers. Default false — alerting is fleet-level, and a channel that fires on every job is
  // filtered into a folder within a week. See docs/superpowers/specs/2026-09-10-job-event-notifications-design.md.
  deliverJobEvents      Boolean                 @default(false)
```

and the new model:

```prisma
// Outbox. Written by a database TRIGGER, never by application code — claimNextJob flips
// PENDING -> RUNNING in raw SQL and no Prisma hook can see it, so an application-side writer would
// silently miss the most common transition in the system. Written in the job's own transaction, so
// an event cannot be lost between the state change and the record of it.
model JobEvent {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId String
  jobId          String
  kind           JobKind
  state          JobState
  at             DateTime  @default(now())
  // Set once a delivery pass has attempted this event, whether or not every channel accepted it —
  // the trade-off notificationState already makes, so one dead channel cannot replay the backlog
  // to the healthy ones forever. Pruned 24h later.
  deliveredAt    DateTime?

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([deliveredAt, at])
  @@index([organizationId])
}
```

and on `Organization`, beside `notificationChannels`:

```prisma
  jobEvents            JobEvent[]
```

- [ ] **Step 4: Write the migration**

Create `apps/server/prisma/migrations/20260910170000_job_event_outbox/migration.sql`:

```sql
-- One row per BackupJob state transition, for channels that opted into the job firehose.
--
-- Written by a TRIGGER rather than by application code, and the reason is specific: claimNextJob
-- (jobs/claim.ts) performs PENDING -> RUNNING in raw SQL, because the claim has to be atomic
-- against concurrent workers (FOR UPDATE SKIP LOCKED). A Prisma client extension — the mechanism
-- data/scope.ts uses for organizationId — never sees that statement, so an application-side writer
-- would miss the single most common transition in the system.
--
-- AFTER, not BEFORE: the row is recorded only once the change has actually been made. In the job's
-- own transaction, so the event cannot survive a rolled-back state change, and cannot be lost to a
-- crash between the two writes.
ALTER TABLE "NotificationChannel" ADD COLUMN "deliverJobEvents" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "JobEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "state" "JobState" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobEvent_deliveredAt_at_idx" ON "JobEvent"("deliveredAt", "at");
CREATE INDEX "JobEvent_organizationId_idx" ON "JobEvent"("organizationId");

ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION record_job_event() RETURNS TRIGGER AS $$
BEGIN
    -- UPDATE OF state still fires when state is written with its current value; comparing here
    -- keeps "the operator saw three deliveries" honest when an unrelated write touches the column.
    IF (TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state) THEN
        RETURN NULL;
    END IF;
    INSERT INTO "JobEvent" ("organizationId", "jobId", "kind", "state")
    VALUES (NEW."organizationId", NEW."id", NEW."kind", NEW."state");
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_state_outbox
    AFTER INSERT OR UPDATE OF state ON "BackupJob"
    FOR EACH ROW EXECUTE FUNCTION record_job_event();
```

- [ ] **Step 5: Regenerate the client and run the test**

Run: `cd apps/server && npx prisma generate && SCHRODUMP_TEST_INTEGRATION=1 npx vitest run src/jobs/job-event-trigger.integration.test.ts`
Expected: PASS, both cases.

- [ ] **Step 6: Prove the trigger is load-bearing**

Comment out the `CREATE TRIGGER` in a scratch copy of the database, re-run the first test, confirm
it fails with `[] !== ["PENDING","RUNNING"]`, then restore. A test that passes without the trigger
is testing nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/server/prisma apps/server/src/jobs/job-event-trigger.integration.test.ts
git commit -s -m "feat(notifications): a trigger records every job state transition to an outbox"
```

---

### Task 2: The wire shape for a job event

**Files:**
- Modify: `apps/server/src/notifications/deliver.ts`
- Modify: `apps/server/src/notifications/webhook.ts`
- Modify: `apps/server/src/notifications/smtp.ts`
- Test: `apps/server/src/notifications/webhook.test.ts`, `apps/server/src/notifications/smtp.test.ts`

**Interfaces:**
- Consumes: `DeliverableNotification` from Task 0 (already in `deliver.ts`).
- Produces: `DeliverableTrigger` gains `"JOB_STATE"`; `DeliverableNotification.kind` gains
  `"occurred"`; `DeliverableNotification.job?: { id: string; kind: string; state: string; policyId: string | null }`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/notifications/webhook.test.ts`:

```ts
describe("a job event on the wire", () => {
  it("carries the job's kind and state as fields, not only as prose", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverWebhook(
      { fetch: fetchMock },
      { url: "https://hooks.example/x", secret: "s" },
      {
        trigger: "JOB_STATE",
        key: "job-1",
        kind: "occurred",
        summary: 'BACKUP job for policy "shop-daily" is RUNNING',
        job: { id: "job-1", kind: "BACKUP", state: "RUNNING", policyId: "pol-1" },
      },
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.job).toEqual({ id: "job-1", kind: "BACKUP", state: "RUNNING", policyId: "pol-1" });
  });

  it("gives each transition of one job its own idempotency key", async () => {
    // The key derives from the CONDITION. Without the state in it, PENDING, RUNNING and SUCCEEDED
    // of the same job share a key and a deduplicating receiver keeps one of the three.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const base = {
      trigger: "JOB_STATE" as const,
      key: "job-1",
      kind: "occurred" as const,
      summary: "s",
    };
    for (const state of ["PENDING", "RUNNING", "SUCCEEDED"]) {
      await deliverWebhook(
        { fetch: fetchMock },
        { url: "https://hooks.example/x", secret: "s" },
        { ...base, job: { id: "job-1", kind: "BACKUP", state, policyId: null } },
      );
    }
    const keys = fetchMock.mock.calls.map(
      (c) => (c[1] as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"],
    );
    expect(new Set(keys).size).toBe(3);
  });
});
```

In `apps/server/src/notifications/smtp.test.ts`:

```ts
describe("a job event by email", () => {
  it("says which job and which state in the subject", async () => {
    const m = fakeMailer();
    await deliverEmail({ ...m.deps, ca: null }, TARGET, {
      trigger: "JOB_STATE",
      key: "job-1",
      kind: "occurred",
      summary: "s",
      job: { id: "job-1", kind: "BACKUP", state: "RUNNING", policyId: null },
    });
    expect(String(m.created.length && m.sent[0]?.subject)).toMatch(/BACKUP.*RUNNING/);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/server && npx vitest run src/notifications/webhook.test.ts src/notifications/smtp.test.ts`
Expected: FAIL — type error on `job`, and the idempotency keys collapse to one.

- [ ] **Step 3: Widen the payload**

In `deliver.ts`:

```ts
export type DeliverableTrigger = NotificationTrigger | "TEST" | "JOB_STATE";

export interface DeliverableJob {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly policyId: string | null;
}

export interface DeliverableNotification {
  readonly trigger: DeliverableTrigger;
  readonly key: string;
  // "occurred" is a job transition: it neither opens nor resolves a condition, and calling it
  // either would make the other two words mean nothing.
  readonly kind: "opened" | "resolved" | "occurred";
  readonly summary: string;
  // Present only on JOB_STATE. The three fleet triggers describe the fleet, not a job.
  readonly job?: DeliverableJob;
}
```

In `webhook.ts`, include `job` in the body and put the state in the key:

```ts
  const body = JSON.stringify({
    trigger: notification.trigger,
    key: notification.key,
    kind: notification.kind,
    summary: notification.summary,
    ...(notification.job !== undefined ? { job: notification.job } : {}),
  });
```

```ts
function idempotencyKey(notification: DeliverableNotification): string {
  return createHmac("sha256", "schrodump-notification")
    // The job's state joins the key, or every transition of one job carries the same one and a
    // receiver that deduplicates keeps one delivery out of three.
    .update(
      `${notification.trigger}:${notification.key}:${notification.kind}:${notification.job?.state ?? ""}`,
    )
    .digest("hex");
}
```

In `smtp.ts`, ahead of the `TEST` case in `subjectFor`:

```ts
  if (notification.job !== undefined) {
    return `[schrodump] Job: ${notification.job.kind} is ${notification.job.state}`;
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/server && npx vitest run src/notifications/`
Expected: PASS, all of them — the existing idempotency test for fleet triggers must still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/notifications
git commit -s -m "feat(notifications): the wire carries a job event as fields, keyed per transition"
```

---

### Task 3: Draining the outbox

**Files:**
- Create: `apps/server/src/notifications/job-events.ts`
- Create: `apps/server/src/notifications/job-events.test.ts`
- Modify: `apps/server/src/server.ts:256-270`

**Interfaces:**
- Consumes: `deliverToChannel`, `ChannelDeliveryDeps` (`deliver.ts`).
- Produces: `runJobEventNotifications(deps: JobEventDeps): Promise<number>`, returning how many
  events were drained; `JOB_EVENT_DRAIN_LIMIT = 200`; `JOB_EVENT_RETENTION_MS = 86_400_000`.

- [ ] **Step 1: Write the failing tests**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { encryptCredential } from "../crypto/envelope.js";
import { runJobEventNotifications } from "./job-events.js";

const KEK = Buffer.alloc(32, 9);
const NOW = new Date("2026-09-10T12:00:00.000Z");

const OPTED_IN = {
  id: "chan-1", organizationId: "org-1", kind: "WEBHOOK",
  url: "https://hooks.example/x",
  encryptedSecret: JSON.stringify(encryptCredential(KEK, "example-example-example")),
  smtpHost: null, smtpPort: null, smtpUsername: null, encryptedSmtpPassword: null,
  fromAddress: null, toAddresses: [], deliverJobEvents: true,
};

function fakePrisma(channels: unknown[], events: unknown[]) {
  const marked: string[] = [];
  const pruned: unknown[] = [];
  return {
    marked, pruned,
    client: {
      notificationChannel: {
        findMany: () => Promise.resolve(channels),
        update: () => Promise.resolve(channels[0]),
      },
      jobEvent: {
        findMany: () => Promise.resolve(events),
        updateMany: ({ where }: { where: { id: { in: string[] } } }) => {
          marked.push(...where.id.in);
          return Promise.resolve({ count: where.id.in.length });
        },
        deleteMany: (args: unknown) => { pruned.push(args); return Promise.resolve({ count: 0 }); },
      },
    },
  };
}

const EVENT = {
  id: "evt-1", organizationId: "org-1", jobId: "job-1",
  kind: "BACKUP", state: "RUNNING", at: NOW, deliveredAt: null,
  job: { policyId: "pol-1", policy: { name: "shop-daily" } },
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
  };
}

describe("runJobEventNotifications", () => {
  it("delivers a transition to a channel that opted in", async () => {
    const prisma = fakePrisma([OPTED_IN], [EVENT]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await runJobEventNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.trigger).toBe("JOB_STATE");
    expect(body.job.state).toBe("RUNNING");
  });

  it("delivers nothing to a channel that did not opt in, and still clears the event", async () => {
    // The trigger writes unconditionally. If an un-subscribed deployment never marked events
    // delivered, the table would grow forever behind a feature nobody switched on.
    const prisma = fakePrisma([{ ...OPTED_IN, deliverJobEvents: false }], [EVENT]);
    const fetchMock = vi.fn();
    await runJobEventNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.marked).toEqual(["evt-1"]);
  });

  it("marks an event delivered even when a channel refused it", async () => {
    // The same trade-off notificationState makes: otherwise one dead channel replays the whole
    // backlog to the healthy ones on every tick, forever. The failure lands on the channel row.
    const prisma = fakePrisma([OPTED_IN], [EVENT]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await runJobEventNotifications(depsWith(prisma, fetchMock as unknown as typeof fetch));
    expect(prisma.marked).toEqual(["evt-1"]);
  });

  it("prunes delivered events older than the retention window", async () => {
    const prisma = fakePrisma([OPTED_IN], []);
    await runJobEventNotifications(depsWith(prisma, vi.fn() as unknown as typeof fetch));
    expect(prisma.pruned.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/server && npx vitest run src/notifications/job-events.test.ts`
Expected: FAIL — `Cannot find module './job-events.js'`.

- [ ] **Step 3: Implement the drain**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Draining the job-event outbox.
//
// The trigger on BackupJob writes a row inside the job's own transaction and returns; this reads
// committed rows on the scheduler tick and delivers them. Delivery is never in a job's path — a
// notification that fails must never fail a backup.

import type { PrismaClient } from "../db.js";
import type { CredentialAuditSink } from "../crypto/credential-access.js";
import { deliverToChannel, type StoredChannel } from "./deliver.js";
import type { SmtpDeps } from "./smtp.js";

// A burst of jobs must not make one tick unbounded. What is left waits for the next pass.
export const JOB_EVENT_DRAIN_LIMIT = 200;
// Delivered rows are kept briefly for debugging a receiver, then collected.
export const JOB_EVENT_RETENTION_MS = 86_400_000;

export interface JobEventDeps {
  prisma: PrismaClient;
  kek: Buffer;
  audit: CredentialAuditSink;
  now: () => Date;
  fetch: typeof fetch;
  smtp: SmtpDeps;
  log: {
    info(o: Record<string, unknown>, m: string): void;
    error(o: Record<string, unknown>, m: string): void;
  };
}

function summaryOf(kind: string, state: string, policyName: string | null): string {
  return policyName === null
    ? `${kind} job is ${state}`
    : `${kind} job for policy "${policyName}" is ${state}`;
}

export async function runJobEventNotifications(deps: JobEventDeps): Promise<number> {
  const now = deps.now();
  const events = await deps.prisma.jobEvent.findMany({
    where: { deliveredAt: null },
    orderBy: { at: "asc" },
    take: JOB_EVENT_DRAIN_LIMIT,
    include: { job: { select: { policyId: true, policy: { select: { name: true } } } } },
  });

  if (events.length > 0) {
    const channels = (await deps.prisma.notificationChannel.findMany({
      where: { enabled: true, deliverJobEvents: true },
    })) as unknown as (StoredChannel & { organizationId: string })[];

    for (const event of events) {
      for (const channel of channels.filter((c) => c.organizationId === event.organizationId)) {
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
          const reason = err instanceof Error ? err.message : "job event delivery failed";
          deps.log.error({ channelId: channel.id, reason }, "job event delivery failed");
          await deps.prisma.notificationChannel.update({
            where: { id: channel.id },
            data: { lastFailureAt: now, lastFailure: reason },
          });
        }
      }
    }

    // Marked whether or not every channel accepted it, and marked even when NO channel wanted it:
    // the trigger writes unconditionally, so an un-subscribed deployment would otherwise grow a
    // table behind a feature nobody switched on.
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
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/server && npx vitest run src/notifications/job-events.test.ts`
Expected: PASS, four cases.

- [ ] **Step 5: Call it on the tick**

In `apps/server/src/server.ts`, immediately after the `runNotifications({...})` call and inside the
same `try`:

```ts
        // Same tick, same reasoning: the outbox is committed state read after the fact.
        await runJobEventNotifications({
          prisma,
          kek,
          audit: credentialAudit,
          now: () => new Date(),
          fetch,
          smtp,
          log: logger,
        });
```

with `import { runJobEventNotifications } from "./notifications/job-events.js";` beside the existing
notifications import.

- [ ] **Step 6: Verify the workspace**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src
git commit -s -m "feat(notifications): drain the job-event outbox on the scheduler tick"
```

---

### Task 4: Choosing it on a channel

**Files:**
- Modify: `apps/server/src/routes/notifications.ts`
- Modify: `apps/server/src/routes/wiring.ts` (`prismaNotificationChannelStore`)
- Test: `apps/server/src/routes/notifications.test.ts`

**Interfaces:**
- Produces: `CreateChannelData.deliverJobEvents: boolean`; `ChannelRecord.deliverJobEvents: boolean`;
  both branches of `CreateChannelSchema` accept `deliverJobEvents?: boolean` (default `false`).

- [ ] **Step 1: Write the failing tests**

```ts
describe("notification channels — the job firehose is opt-in", () => {
  it("defaults to off, because alerting is fleet-level", async () => {
    const seen: CreateChannelData[] = [];
    const app = await appWith("operator", {
      create: (data) => { seen.push(data); return Promise.resolve(RECORD); },
    });
    await app.inject({ method: "POST", url: "/notification-channels", payload: WEBHOOK });
    expect(seen[0]?.deliverJobEvents).toBe(false);
    await app.close();
  });

  it("carries the choice through to the store when asked for", async () => {
    const seen: CreateChannelData[] = [];
    const app = await appWith("operator", {
      create: (data) => { seen.push(data); return Promise.resolve(RECORD); },
    });
    await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, deliverJobEvents: true },
    });
    expect(seen[0]?.deliverJobEvents).toBe(true);
    await app.close();
  });

  it("still refuses a stray field from the other kind", async () => {
    // .strict() is what makes "one row is one kind" enforceable; adding an optional field to both
    // branches must not open a hole in that.
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/notification-channels",
      payload: { ...WEBHOOK, deliverJobEvents: true, smtpHost: "smtp.example" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { field?: string }).field).toBe("smtpHost");
    await app.close();
  });
});
```

Add `deliverJobEvents: false` to the `RECORD` fixture at the top of the file.

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/server && npx vitest run src/routes/notifications.test.ts`
Expected: FAIL — `deliverJobEvents` is `undefined` on the store call.

- [ ] **Step 3: Widen the schema, the DTO and the store**

In `routes/notifications.ts`, add to **both** branches of `CreateChannelSchema`, inside the object
and before `.strict()`:

```ts
      // Opt-in firehose, off unless asked for. On both branches rather than outside the union: the
      // union is what makes a row one kind, and hoisting a field out of it would weaken that.
      deliverJobEvents: z.boolean().default(false),
```

Add `deliverJobEvents: boolean;` to `CreateChannelData` and to `ChannelRecord`; add
`deliverJobEvents: channel.deliverJobEvents,` to `toPublic`; and pass
`deliverJobEvents: input.deliverJobEvents,` in **both** arms of the `data` construction.

In `routes/wiring.ts`, add `deliverJobEvents: data.deliverJobEvents,` to the `create` call's `data`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/server && npx vitest run src/routes/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes
git commit -s -m "feat(api): a channel chooses whether job events reach it"
```

---

### Task 5: The choice in the interface

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/components/notification-channels.tsx`
- Modify: `apps/web/src/i18n/messages/en.ts`, `pt-BR.ts`, `es.ts`
- Test: `apps/web/src/components/notification-channels.test.tsx`

**Interfaces:**
- Consumes: `NotificationChannel.deliverJobEvents: boolean` from the API.

- [ ] **Step 1: Write the failing tests**

```ts
describe("ChannelForm — the job firehose is a choice, and a loud one", () => {
  it("sends deliverJobEvents false unless it is asked for", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve(WEBHOOK) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.type(screen.getByLabelText("Webhook URL"), "https://hooks.example/y");
    await user.type(screen.getByLabelText("Signing secret"), "a-signing-secret-value");
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.deliverJobEvents).toBe(false);
  });

  it("sends it when the firehose is chosen", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve(WEBHOOK) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.type(screen.getByLabelText("Webhook URL"), "https://hooks.example/y");
    await user.type(screen.getByLabelText("Signing secret"), "a-signing-secret-value");
    await user.click(screen.getByLabelText(/every job/i));
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.deliverJobEvents).toBe(true);
  });

  it("warns that the firehose is a firehose", async () => {
    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.click(screen.getByLabelText(/every job/i));
    expect(screen.getByText(/high volume/i)).toBeInTheDocument();
  });
});

describe("ChannelRow — what a channel is subscribed to is visible", () => {
  it("marks a channel that receives every job", () => {
    renderWith(<ChannelRow channel={{ ...WEBHOOK, deliverJobEvents: true }} canEdit />);
    expect(screen.getByText(/every job/i)).toBeInTheDocument();
  });

  it("says nothing extra for a fleet-only channel", () => {
    renderWith(<ChannelRow channel={WEBHOOK} canEdit />);
    expect(screen.queryByText(/every job/i)).toBeNull();
  });
});
```

Add `deliverJobEvents: false` to the `WEBHOOK` fixture.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && npx vitest run src/components/notification-channels.test.tsx`
Expected: FAIL — no such control, `deliverJobEvents` absent from the body.

- [ ] **Step 3: Add the field, the control and the strings**

`types.ts` — add to `NotificationChannel`:

```ts
  // Opt-in firehose: one delivery per job state transition, on top of the three fleet triggers.
  deliverJobEvents: boolean;
```

`notification-channels.tsx` — in `ChannelForm`, add state and include it in **both** arms of `body`:

```ts
  const [jobEvents, setJobEvents] = useState(false);
```

```ts
        ? { kind, url: value("url"), secret: value("secret"), deliverJobEvents: jobEvents }
```

(and `deliverJobEvents: jobEvents,` in the SMTP arm), plus the control above `<SaveBar>`:

```tsx
      <div className="space-y-2">
        <FieldLabel htmlFor="channel-jobEvents">{t("notifications.subscription")}</FieldLabel>
        <label className="flex items-start gap-2.5 text-[12.5px]">
          <input
            id="channel-jobEvents"
            type="checkbox"
            checked={jobEvents}
            onChange={(event) => setJobEvents(event.target.checked)}
            className="mt-0.5"
          />
          <span>{t("notifications.subscription.jobs")}</span>
        </label>
        {/* Said before it is switched on, not discovered afterwards: this is the choice the
            architecture warns about, and an operator gets to make it with the warning in hand. */}
        {jobEvents ? <FieldHelp>{t("notifications.subscription.jobs.warning")}</FieldHelp> : null}
      </div>
```

In `ChannelRow`, beside the disabled badge:

```tsx
          {channel.deliverJobEvents ? (
            <span className="mt-1 inline-block rounded-sm border border-border-region bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-[0.13em] uppercase text-muted-foreground">
              {t("notifications.subscription.jobs.badge")}
            </span>
          ) : null}
```

Strings — `en.ts`:

```ts
  "notifications.subscription": "What to send",
  "notifications.subscription.jobs": "Also send every job state change, not only the fleet's open questions",
  "notifications.subscription.jobs.warning": "High volume: one delivery per job, per state change. Alerting is fleet-level for a reason — a channel that fires on every job tends to get filtered, and the alerts that matter go with it.",
  "notifications.subscription.jobs.badge": "every job",
```

`pt-BR.ts`:

```ts
  "notifications.subscription": "O que enviar",
  "notifications.subscription.jobs": "Enviar também cada mudança de estado de job, não só as perguntas em aberto da frota",
  "notifications.subscription.jobs.warning": "Volume alto: uma entrega por job, por mudança de estado. O alerta é no nível da frota por um motivo — um canal que apita a cada job costuma acabar filtrado, e os alertas que importam vão junto.",
  "notifications.subscription.jobs.badge": "cada job",
```

`es.ts`:

```ts
  "notifications.subscription": "Qué enviar",
  "notifications.subscription.jobs": "Enviar también cada cambio de estado de job, no solo las preguntas abiertas de la flota",
  "notifications.subscription.jobs.warning": "Volumen alto: una entrega por job, por cambio de estado. La alerta es a nivel de flota por una razón — un canal que suena en cada job termina filtrado, y las alertas que importan se van con él.",
  "notifications.subscription.jobs.badge": "cada job",
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit && npx eslint src/`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -s -m "feat(web): a channel's subscription is a choice, with the volume stated before it is made"
```

---

### Task 6: Proving it in the shipped image, and writing down why

**Files:**
- Modify: `scripts/smoke-compose.sh` (renumber `/19` → `/20`, new step 20)
- Modify: `apps/server/CLAUDE.md` (Notifications section)
- Modify: `docs/install.md` (Configuration → the notifications note)

- [ ] **Step 1: Add the smoke step**

After step 19, before the closing `printf`:

```bash
# The trigger is the one part of this feature that no unit test can reach: it lives in the database,
# it fires on a raw-SQL UPDATE, and the thing it has to survive is the real migration running
# against the real image. A subscribed channel here proves the whole chain — trigger to outbox to
# drain to wire.
log "20/20  a job event reaching a subscribed channel, written by a trigger nobody can bypass"
api -o /dev/null -w '   channel %{http_code}\n' -X POST -H "$JSON" \
  -d "{\"kind\":\"WEBHOOK\",\"url\":\"http://${PROJECT}-hook:9999/hook\",\"secret\":\"a-signing-secret-long-enough\",\"deliverJobEvents\":true}" \
  "${BASE}/backend/notification-channels"

before="$(docker logs "${PROJECT}-hook" 2>&1 | grep -c "Idempotency-Key" || true)"
api -o /dev/null -w '   backup %{http_code}\n' -X POST -H "$JSON" \
  -d "{\"policyId\":\"${policy}\"}" "${BASE}/backend/jobs"

for attempt in $(seq 1 36); do
  sleep 5
  after="$(docker logs "${PROJECT}-hook" 2>&1 | grep -c "Idempotency-Key" || true)"
  [ "$after" -gt "$before" ] && { printf '   job events arrived after %ss\n' "$((attempt * 5))"; break; }
  [ "$attempt" -eq 36 ] && {
    printf '\n--- listener ---\n%s\n' "$(docker logs "${PROJECT}-hook" 2>&1 | tail -20)" >&2
    fail "a manual backup produced no job event on a subscribed channel"
  }
done
```

- [ ] **Step 2: Record the reasoning**

In `apps/server/CLAUDE.md`, under Notifications:

```markdown
- **Job events are an opt-in firehose, and the fleet default is unchanged.** `evaluate.ts` still
  emits only the three fleet triggers; `deliverJobEvents` on a channel adds one delivery per
  `BackupJob` state transition. The architecture decision — the unit is the fleet, not the job — is
  intact: this adds an axis to it rather than reversing it, and the UI states the volume before the
  choice is made.
- **The outbox is written by a database TRIGGER, never by application code.** `claimNextJob` flips
  `PENDING → RUNNING` in raw SQL for atomicity, which no Prisma extension can observe, so an
  application-side writer would miss the most common transition in the system. The trigger also
  catches whatever write site is added next year by someone who never read this file. It writes in
  the job's own transaction, so an event cannot outlive a rolled-back state change.
- **An event is marked delivered after the pass that attempted it**, accepted or not — the same
  trade-off `notificationState` makes, so one dead channel cannot replay the backlog to the healthy
  ones forever. Events are marked even when no channel subscribed, or the trigger would grow a
  table behind a feature nobody switched on.
```

In `docs/install.md`, under the notifications guidance, one paragraph naming the checkbox and the
volume.

- [ ] **Step 3: Verify everything**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 4: Commit and open the PR**

```bash
git add -A
git commit -s -m "docs(notifications): record why the outbox is a trigger, and prove a job event in the smoke"
```

---

## Self-review

**Spec coverage.** Per-channel opt-in → Tasks 4, 5. Every transition → Task 1 (trigger on every
`state` write) + Task 3 (drain per row). Trigger capture including raw SQL → Task 1, asserted by
integration test. Outbox out of the job's path → Task 3, called from the tick. At-least-once and
idempotency per transition → Task 2 (key includes state), Task 3 (mark after attempt). Bounded and
pruned → Task 3. Wire shape → Task 2. Rationale recorded → Task 6.

**Types.** `deliverJobEvents` is the column, the DTO field, the Zod key and the React state
throughout. `DeliverableNotification.job` is optional everywhere it appears. `runJobEventNotifications`
is the name in Task 3 and in `server.ts`.

**Open risk to watch during execution.** `gen_random_uuid()` is built into PostgreSQL 13+; the
supported range starts at `postgres:13-alpine` per `ci.yml`, so it needs no `pgcrypto` extension —
confirm against the oldest image in the integration matrix before relying on it.
