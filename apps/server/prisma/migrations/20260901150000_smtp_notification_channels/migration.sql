-- CreateEnum
CREATE TYPE "NotificationChannelKind" AS ENUM ('WEBHOOK', 'SMTP');

-- AlterTable
-- url and encryptedSecret become nullable: they are WEBHOOK-only now. Existing rows are all
-- webhooks, so the default and the backfill agree without touching data.
ALTER TABLE "NotificationChannel"
  ADD COLUMN "kind" "NotificationChannelKind" NOT NULL DEFAULT 'WEBHOOK',
  ADD COLUMN "smtpHost" TEXT,
  ADD COLUMN "smtpPort" INTEGER,
  ADD COLUMN "smtpUsername" TEXT,
  ADD COLUMN "encryptedSmtpPassword" TEXT,
  ADD COLUMN "fromAddress" TEXT,
  ADD COLUMN "toAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "url" DROP NOT NULL,
  ALTER COLUMN "encryptedSecret" DROP NOT NULL;
