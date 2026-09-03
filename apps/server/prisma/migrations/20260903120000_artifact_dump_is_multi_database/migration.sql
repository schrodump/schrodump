-- AlterTable
-- mysql/mariadb only: whether the dump script carries more than one database. Nullable on purpose,
-- and NULL is not "no": every artifact written before this column existed has an unrecorded answer,
-- which is a weaker claim than false. Restore refuses a sub-cluster target on both NULL and true —
-- a mysqldump script replays its own USE statements and no flag confines it — and only a recorded
-- false clears that gate. Unlike "sourceHasOplog", NULL here is recoverable without touching the
-- origin: the manifest in the bucket carries the dump scope, so a catalog rebuild fills it in.
ALTER TABLE "Artifact" ADD COLUMN "dumpIsMultiDatabase" BOOLEAN;
