-- CreateEnum
CREATE TYPE "SelfBackupState" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "SelfBackup" (
    "id" TEXT NOT NULL,
    "state" "SelfBackupState" NOT NULL DEFAULT 'RUNNING',
    "organizationId" TEXT,
    "destinationId" TEXT NOT NULL,
    "bucketKey" TEXT,
    "manifestKey" TEXT,
    "sizeBytes" BIGINT,
    "checksum" TEXT,
    "keyIds" TEXT[],
    "reason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SelfBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SelfBackup_startedAt_idx" ON "SelfBackup"("startedAt");
