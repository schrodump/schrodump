-- AlterTable
-- postgres only: whether the globals dump beside the artifact carries role password hashes. Nullable
-- on purpose, and NULL is not "no": it is every artifact written before this column existed, and
-- every engine that has no globals dump at all. Deliberately not back-filled. Every postgres
-- artifact already in the catalog did capture them — until now a role that could not read
-- pg_authid failed the whole backup, so none could be written without them — but that is an
-- inference from the code's history, and this column records what a dump did, not what it must
-- have done.
ALTER TABLE "Artifact" ADD COLUMN "rolePasswordsCaptured" BOOLEAN;
