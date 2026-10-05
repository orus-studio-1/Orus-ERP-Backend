-- AlterTable
ALTER TABLE "PlatformAuditLog"
ADD COLUMN "statusBefore" TEXT,
ADD COLUMN "statusAfter" TEXT,
ADD COLUMN "message" TEXT,
ADD COLUMN "targetUserId" TEXT,
ADD COLUMN "targetRoleId" TEXT,
ADD COLUMN "rfqId" TEXT;

-- CreateIndex
CREATE INDEX "PlatformAuditLog_tenantId_rfqId_createdAt_idx" ON "PlatformAuditLog"("tenantId", "rfqId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_tenantId_targetUserId_createdAt_idx" ON "PlatformAuditLog"("tenantId", "targetUserId", "createdAt");
