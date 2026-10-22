-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('DRAFT', 'EXPORTED', 'GENERATED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EInvoiceSourceType" AS ENUM ('SALES_INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "EInvoiceOverrideMode" AS ENUM ('NONE', 'FORCE_ON', 'FORCE_OFF');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "einvoiceExempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "einvoiceExempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CustomerAddress" ADD COLUMN     "gstin" TEXT;

-- CreateTable
CREATE TABLE "EInvoiceConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "provider" TEXT,
    "hardBlockOnSubmit" BOOLEAN NOT NULL DEFAULT false,
    "overrideMode" "EInvoiceOverrideMode" NOT NULL DEFAULT 'NONE',
    "overrideReason" TEXT,
    "overrideById" TEXT,
    "overrideAt" TIMESTAMP(3),
    "followUpDays" INTEGER NOT NULL DEFAULT 2,
    "credentialsEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EInvoiceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoiceRuleVersion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "turnoverThreshold" DECIMAL(18,2) NOT NULL,
    "reportingWindowDays" INTEGER NOT NULL,
    "reportingWindowTurnoverFloor" DECIMAL(18,2),
    "warnAtPercents" INTEGER[] DEFAULT ARRAY[50, 80]::INTEGER[],
    "cancelWindowHours" INTEGER NOT NULL,
    "maxDocNoLength" INTEGER NOT NULL DEFAULT 16,
    "shipToGstinMandatoryFrom" TIMESTAMP(3),
    "schemaVersion" TEXT,
    "verifiedByCa" BOOLEAN NOT NULL DEFAULT false,
    "caName" TEXT,
    "caVerifiedAt" TIMESTAMP(3),
    "caReference" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EInvoiceRuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoiceTurnover" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "pan" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "aggregateTurnover" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EInvoiceTurnover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceType" "EInvoiceSourceType" NOT NULL,
    "salesInvoiceId" TEXT,
    "creditNoteId" TEXT,
    "docType" TEXT NOT NULL DEFAULT 'INV',
    "docNo" TEXT NOT NULL,
    "docDate" TIMESTAMP(3) NOT NULL,
    "financialYear" TEXT NOT NULL,
    "supplyType" TEXT NOT NULL DEFAULT 'B2B',
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "precedingDocNo" TEXT,
    "precedingDocDate" TIMESTAMP(3),
    "sellerGstin" TEXT NOT NULL,
    "sellerName" TEXT,
    "sellerAddr1" TEXT,
    "sellerAddr2" TEXT,
    "sellerPlace" TEXT,
    "sellerPincode" TEXT,
    "sellerStateCode" TEXT,
    "buyerGstin" TEXT NOT NULL,
    "buyerName" TEXT,
    "buyerAddr1" TEXT,
    "buyerAddr2" TEXT,
    "buyerPlace" TEXT,
    "buyerPincode" TEXT,
    "buyerStateCode" TEXT,
    "placeOfSupply" TEXT,
    "hasShipTo" BOOLEAN NOT NULL DEFAULT false,
    "shipToGstin" TEXT,
    "shipToName" TEXT,
    "shipToAddr1" TEXT,
    "shipToAddr2" TEXT,
    "shipToPlace" TEXT,
    "shipToPincode" TEXT,
    "shipToStateCode" TEXT,
    "taxableValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cgstValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "sgstValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "igstValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cessValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "discountValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "otherCharges" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "payload" JSONB,
    "irn" TEXT,
    "ackNo" TEXT,
    "ackDate" TIMESTAMP(3),
    "signedInvoice" TEXT,
    "signedQr" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "exportedAt" TIMESTAMP(3),
    "reportingDeadline" TIMESTAMP(3),
    "ruleVersionId" TEXT,
    "cancelDeadline" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReasonCode" TEXT,
    "cancelRemark" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoiceItem" (
    "id" TEXT NOT NULL,
    "einvoiceId" TEXT NOT NULL,
    "slNo" INTEGER NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "description" TEXT,
    "isService" BOOLEAN NOT NULL DEFAULT false,
    "hsnCode" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "grossAmount" DECIMAL(18,6) NOT NULL,
    "discount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(18,6) NOT NULL,
    "cgstRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "sgstRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "igstRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "cessRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cessAmount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "totalItemValue" DECIMAL(18,6) NOT NULL DEFAULT 0,

    CONSTRAINT "EInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoiceEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "einvoiceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EInvoiceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoiceWarning" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EInvoiceWarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceConfig_companyId_key" ON "EInvoiceConfig"("companyId");

-- CreateIndex
CREATE INDEX "EInvoiceRuleVersion_companyId_effectiveFrom_idx" ON "EInvoiceRuleVersion"("companyId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceRuleVersion_companyId_effectiveFrom_key" ON "EInvoiceRuleVersion"("companyId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceTurnover_companyId_pan_financialYear_key" ON "EInvoiceTurnover"("companyId", "pan", "financialYear");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoice_irn_key" ON "EInvoice"("irn");

-- CreateIndex
CREATE INDEX "EInvoice_companyId_status_idx" ON "EInvoice"("companyId", "status");

-- CreateIndex
CREATE INDEX "EInvoice_salesInvoiceId_idx" ON "EInvoice"("salesInvoiceId");

-- CreateIndex
CREATE INDEX "EInvoice_creditNoteId_idx" ON "EInvoice"("creditNoteId");

-- CreateIndex
CREATE INDEX "EInvoice_companyId_docNo_idx" ON "EInvoice"("companyId", "docNo");

-- CreateIndex
CREATE INDEX "EInvoice_companyId_reportingDeadline_idx" ON "EInvoice"("companyId", "reportingDeadline");

-- CreateIndex
CREATE INDEX "EInvoiceItem_einvoiceId_idx" ON "EInvoiceItem"("einvoiceId");

-- CreateIndex
CREATE INDEX "EInvoiceEvent_einvoiceId_createdAt_idx" ON "EInvoiceEvent"("einvoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "EInvoiceWarning_companyId_idx" ON "EInvoiceWarning"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceWarning_sourceKey_level_key" ON "EInvoiceWarning"("sourceKey", "level");

-- AddForeignKey
ALTER TABLE "EInvoice" ADD CONSTRAINT "EInvoice_salesInvoiceId_fkey" FOREIGN KEY ("salesInvoiceId") REFERENCES "SalesInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EInvoice" ADD CONSTRAINT "EInvoice_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EInvoiceItem" ADD CONSTRAINT "EInvoiceItem_einvoiceId_fkey" FOREIGN KEY ("einvoiceId") REFERENCES "EInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EInvoiceEvent" ADD CONSTRAINT "EInvoiceEvent_einvoiceId_fkey" FOREIGN KEY ("einvoiceId") REFERENCES "EInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

