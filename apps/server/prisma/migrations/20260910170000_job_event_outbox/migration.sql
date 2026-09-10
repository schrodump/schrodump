-- One row per BackupJob state transition, for channels that opted into the job firehose.
--
-- Written by a TRIGGER rather than by application code, and the reason is specific: claimNextJob
-- (jobs/claim.ts) performs PENDING -> RUNNING in raw SQL, because the claim has to be atomic
-- against concurrent workers (FOR UPDATE SKIP LOCKED). A Prisma client extension — the mechanism
-- data/scope.ts uses to inject organizationId — never sees that statement, so an application-side
-- writer would miss the single most common transition in the system. The trigger also catches
-- whatever write site is added next year by someone who never read this file.
--
-- AFTER, not BEFORE: the row is recorded only once the change has actually been made. In the job's
-- own transaction, so an event cannot outlive a rolled-back state change, and cannot be lost to a
-- crash between the state change and the record of it.
ALTER TABLE "NotificationChannel" ADD COLUMN "deliverJobEvents" BOOLEAN NOT NULL DEFAULT false;

-- gen_random_uuid() is core from PostgreSQL 13; the metadata database is 16 in the integration
-- suites and 18 in compose.yaml, so no pgcrypto extension is required.
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

-- The drain reads undelivered rows oldest-first; the prune deletes delivered rows by age.
CREATE INDEX "JobEvent_deliveredAt_at_idx" ON "JobEvent"("deliveredAt", "at");
CREATE INDEX "JobEvent_organizationId_idx" ON "JobEvent"("organizationId");

ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade from the job as well as the organization: an outbox row that outlived the job it
-- describes would be undeliverable prose about a row nobody can look up.
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "BackupJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "JobEvent_jobId_idx" ON "JobEvent"("jobId");

CREATE FUNCTION record_job_event() RETURNS TRIGGER AS $$
BEGIN
    -- `UPDATE OF state` fires when the column is WRITTEN, including with the value it already
    -- holds. Comparing here keeps "one transition, one delivery" true when an unrelated write
    -- touches the column, instead of spending a delivery announcing nothing.
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
