-- Records HOW an artifact reached VERIFIED/FAILED: the verify level that actually ran, and whether
-- it was a downgrade from what the policy asked. Lets the dashboard tell a full-restore green from a
-- checksum-only one (and a downgraded checksum from a requested one), which the ternary state alone
-- cannot. NULL/false backfill the existing rows: their level was never recorded, and a re-verify
-- populates it. See docs/backup-restore.md.
ALTER TABLE "Artifact" ADD COLUMN "verifiedLevel" "VerifyLevel";
ALTER TABLE "Artifact" ADD COLUMN "verifiedDegraded" BOOLEAN NOT NULL DEFAULT false;
