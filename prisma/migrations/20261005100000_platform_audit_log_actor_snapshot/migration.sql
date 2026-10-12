-- Keeps who performed an action even after the user is deleted or deactivated. Legacy invoicing
-- audit rows carried actorEmail/actorRole; the first backfill dropped them, so they are copied now
-- (matching rows through the same md5-derived id the backfill used). Additive and re-runnable.
ALTER TABLE "PlatformAuditLog" ADD COLUMN IF NOT EXISTS "actorEmail" TEXT;
ALTER TABLE "PlatformAuditLog" ADD COLUMN IF NOT EXISTS "actorRole" TEXT;

UPDATE "PlatformAuditLog" p
SET "actorEmail" = a."actorEmail", "actorRole" = a."actorRole"
FROM "AuditLog" a
WHERE p."id" = md5('AuditLog:' || a."id")::uuid
  AND (p."actorEmail" IS NULL OR p."actorRole" IS NULL);
