-- AlterTable
-- The two operator-triggered checks ran, answered one browser and were forgotten, so the guided
-- setup could never tick them off and the deployment could not be asked later whether a target had
-- ever been reached or a bucket ever proven writable. Nullable: NULL means never run, which is a
-- different answer from "ran and failed" and the checklist only stops asking for one of them.
ALTER TABLE "DatabaseTarget" ADD COLUMN "lastProbeAt" TIMESTAMP(3);
ALTER TABLE "DatabaseTarget" ADD COLUMN "lastProbeOk" BOOLEAN;
-- The failure CODE, never the driver's message: driver errors embed the credential they failed
-- with, and this row is returned to every viewer.
ALTER TABLE "DatabaseTarget" ADD COLUMN "lastProbeFailure" TEXT;
ALTER TABLE "StorageDestination" ADD COLUMN "lastCanaryAt" TIMESTAMP(3);
ALTER TABLE "StorageDestination" ADD COLUMN "lastCanaryOk" BOOLEAN;
