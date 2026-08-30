-- AlterTable
-- Nullable on purpose: every artifact written before this column existed has unknown provenance,
-- which is a weaker claim than false. Restore distinguishes the two — NULL degrades with a recorded
-- reason, false simply means the archive has no oplog to replay.
ALTER TABLE "Artifact" ADD COLUMN "sourceHasOplog" BOOLEAN;
