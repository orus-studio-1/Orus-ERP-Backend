-- Copies (does not move) the legacy audit tables into PlatformAuditLog so the central audit trail
-- can read a single table. Legacy tables are left untouched. Ids are derived from the legacy id
-- (md5 -> uuid) so re-running this script never duplicates a row, and tenantId is resolved from
-- the owning company so the rows stay visible to tenant-scoped reads.

-- Document audit trail (invoicing): AuditLog -> PlatformAuditLog
INSERT INTO "PlatformAuditLog" ("id", "tenantId", "companyId", "userId", "entityType", "entityId", "action", "statusBefore", "statusAfter", "message", "diff", "createdAt")
SELECT md5('AuditLog:' || a."id")::uuid, c."tenantId", a."companyId", a."actorId", a."entityType"::text, a."entityId", a."action", a."statusBefore", a."statusAfter", a."message", a."diff", a."createdAt"
FROM "AuditLog" a
LEFT JOIN "Company" c ON c."id" = a."companyId"
ON CONFLICT ("id") DO NOTHING;

-- Access control audit trail: AccessAuditLog -> PlatformAuditLog
INSERT INTO "PlatformAuditLog" ("id", "tenantId", "companyId", "userId", "entityType", "entityId", "action", "targetUserId", "targetRoleId", "message", "before", "after", "createdAt")
SELECT md5('AccessAuditLog:' || a."id")::uuid, c."tenantId", a."companyId", a."actorId", 'ACCESS', COALESCE(a."targetRoleId", a."targetUserId"), a."action", a."targetUserId", a."targetRoleId", a."message", a."before", a."after", a."createdAt"
FROM "AccessAuditLog" a
LEFT JOIN "Company" c ON c."id" = a."companyId"
ON CONFLICT ("id") DO NOTHING;

-- Procurement business events: ProcurementAuditEvent -> PlatformAuditLog
INSERT INTO "PlatformAuditLog" ("id", "tenantId", "companyId", "userId", "entityType", "entityId", "action", "rfqId", "message", "before", "after", "createdAt")
SELECT md5('ProcurementAuditEvent:' || a."id")::uuid, c."tenantId", a."companyId", a."actorId", a."entityType", a."entityId", a."action", a."rfqId", a."message", a."before", a."after", a."createdAt"
FROM "ProcurementAuditEvent" a
LEFT JOIN "Company" c ON c."id" = a."companyId"
ON CONFLICT ("id") DO NOTHING;
