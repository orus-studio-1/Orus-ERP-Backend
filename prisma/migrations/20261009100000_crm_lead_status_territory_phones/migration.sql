-- Lead status: rename the old values (existing rows keep their meaning) and add the new ones.
-- NEW -> LEAD, CONTACTED -> OPEN, QUALIFIED -> INTERESTED. CONVERTED and UNQUALIFIED stay.
ALTER TYPE "LeadStatus" RENAME VALUE 'NEW' TO 'LEAD';
ALTER TYPE "LeadStatus" RENAME VALUE 'CONTACTED' TO 'OPEN';
ALTER TYPE "LeadStatus" RENAME VALUE 'QUALIFIED' TO 'INTERESTED';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'REPLIED';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'OPPORTUNITY';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'QUOTATION';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'LOST_QUOTATION';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'DO_NOT_CONTACT';
ALTER TABLE "Lead" ALTER COLUMN "status" SET DEFAULT 'LEAD';

-- Organization territory.
ALTER TABLE "CrmOrganization" ADD COLUMN "territory" TEXT;

-- Territory master list.
CREATE TABLE "CrmTerritory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CrmTerritory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CrmTerritory_companyId_name_key" ON "CrmTerritory"("companyId", "name");
CREATE INDEX "CrmTerritory_companyId_isActive_sortOrder_idx" ON "CrmTerritory"("companyId", "isActive", "sortOrder");

-- Existing free-text territories become list entries, so nothing already in use is lost.
INSERT INTO "CrmTerritory" ("id", "companyId", "name", "updatedAt")
SELECT 'ter_' || md5(t."companyId" || ':' || t."name"), t."companyId", t."name", CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "companyId", btrim("territory") AS "name" FROM "Lead" WHERE "companyId" IS NOT NULL AND btrim(COALESCE("territory", '')) <> ''
    UNION
    SELECT DISTINCT "companyId", btrim("territory") FROM "Customer" WHERE "companyId" IS NOT NULL AND btrim(COALESCE("territory", '')) <> ''
    UNION
    SELECT DISTINCT "companyId", btrim("territory") FROM "CrmAssignmentRule" WHERE "companyId" IS NOT NULL AND btrim(COALESCE("territory", '')) <> ''
) t
ON CONFLICT DO NOTHING;

-- Phone numbers.
CREATE TABLE "CrmPhone" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "leadId" TEXT,
    "contactId" TEXT,
    "organizationId" TEXT,
    "number" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'MOBILE',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrmPhone_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CrmPhone_companyId_normalized_idx" ON "CrmPhone"("companyId", "normalized");
CREATE INDEX "CrmPhone_leadId_idx" ON "CrmPhone"("leadId");
CREATE INDEX "CrmPhone_contactId_idx" ON "CrmPhone"("contactId");
CREATE INDEX "CrmPhone_organizationId_idx" ON "CrmPhone"("organizationId");
ALTER TABLE "CrmPhone" ADD CONSTRAINT "CrmPhone_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmPhone" ADD CONSTRAINT "CrmPhone_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmPhone" ADD CONSTRAINT "CrmPhone_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "CrmOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The phone each record already has becomes its primary number.
INSERT INTO "CrmPhone" ("id", "companyId", "leadId", "number", "normalized", "type", "isPrimary")
SELECT 'ph_' || md5('lead:' || "id"), "companyId", "id", "phone", regexp_replace("phone", '\D', '', 'g'), 'MOBILE', true
FROM "Lead" WHERE btrim(COALESCE("phone", '')) <> '' AND regexp_replace("phone", '\D', '', 'g') <> '';
INSERT INTO "CrmPhone" ("id", "companyId", "contactId", "number", "normalized", "type", "isPrimary")
SELECT 'ph_' || md5('contact-mobile:' || "id"), "companyId", "id", "mobile", regexp_replace("mobile", '\D', '', 'g'), 'MOBILE', true
FROM "Contact" WHERE btrim(COALESCE("mobile", '')) <> '' AND regexp_replace("mobile", '\D', '', 'g') <> '';
INSERT INTO "CrmPhone" ("id", "companyId", "contactId", "number", "normalized", "type", "isPrimary")
SELECT 'ph_' || md5('contact-phone:' || "id"), "companyId", "id", "phone", regexp_replace("phone", '\D', '', 'g'),
       'WORK', btrim(COALESCE("mobile", '')) = ''
FROM "Contact" WHERE btrim(COALESCE("phone", '')) <> '' AND regexp_replace("phone", '\D', '', 'g') <> '';
INSERT INTO "CrmPhone" ("id", "companyId", "organizationId", "number", "normalized", "type", "isPrimary")
SELECT 'ph_' || md5('org:' || "id"), "companyId", "id", "phone", regexp_replace("phone", '\D', '', 'g'), 'WORK', true
FROM "CrmOrganization" WHERE btrim(COALESCE("phone", '')) <> '' AND regexp_replace("phone", '\D', '', 'g') <> '';
