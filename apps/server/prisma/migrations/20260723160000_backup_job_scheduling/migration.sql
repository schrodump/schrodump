-- AlterTable
ALTER TABLE "BackupJob" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "BackupJob_policyId_scheduledAt_key" ON "BackupJob"("policyId", "scheduledAt");

