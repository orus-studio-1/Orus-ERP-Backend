-- CreateEnum
CREATE TYPE "EwayBillStatus" AS ENUM ('DRAFT', 'EXPORTED', 'GENERATED', 'CANCELLED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "stateCode" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "stateCode" TEXT;

-- CreateTable
CREATE TABLE "EwayBillConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "provider" TEXT,
    "valueThreshold" DECIMAL(18,6) NOT NULL DEFAULT 50000,
    "defaultTransportMode" TEXT NOT NULL DEFAULT 'ROAD',
    "defaultTransporterId" TEXT,
    "defaultTransporter" TEXT,
    "hardBlockOnDispatch" BOOLEAN NOT NULL DEFAULT false,
    "credentialsEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EwayBillConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EwayBill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "billNo" TEXT NOT NULL,
    "status" "EwayBillStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "ewbNo" TEXT,
    "ewbDate" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "irn" TEXT,
    "sourceType" TEXT NOT NULL,
    "salesInvoiceId" TEXT,
    "deliveryNoteId" TEXT,
    "stockTransferOrderId" TEXT,
    "purchaseReturnId" TEXT,
    "supplyType" TEXT NOT NULL DEFAULT 'O',
    "subSupplyType" INTEGER NOT NULL DEFAULT 1,
    "docType" TEXT NOT NULL DEFAULT 'INV',
    "docNo" TEXT NOT NULL,
    "docDate" TIMESTAMP(3) NOT NULL,
    "transactionType" INTEGER NOT NULL DEFAULT 1,
    "dispatchGstin" TEXT NOT NULL,
    "fromGstin" TEXT NOT NULL,
    "fromName" TEXT,
    "fromAddr1" TEXT,
    "fromAddr2" TEXT,
    "fromPlace" TEXT,
    "fromPincode" TEXT,
    "fromStateCode" TEXT,
    "actualFromStateCode" TEXT,
    "toGstin" TEXT NOT NULL,
    "toName" TEXT,
    "toAddr1" TEXT,
    "toAddr2" TEXT,
    "toPlace" TEXT,
    "toPincode" TEXT,
    "toStateCode" TEXT,
    "actualToStateCode" TEXT,
    "taxableValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cgstValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "sgstValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "igstValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cessValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "otherValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "transportMode" TEXT NOT NULL DEFAULT 'ROAD',
    "distanceKm" INTEGER NOT NULL DEFAULT 0,
    "transporterId" TEXT,
    "transporterName" TEXT,
    "transportDocNo" TEXT,
    "transportDocDate" TIMESTAMP(3),
    "vehicleNo" TEXT,
    "vehicleType" TEXT NOT NULL DEFAULT 'R',
    "payload" JSONB,
    "response" JSONB,
    "errorMessage" TEXT,
    "exportedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EwayBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EwayBillItem" (
    "id" TEXT NOT NULL,
    "ewayBillId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "description" TEXT,
    "hsnCode" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "qtyUnit" TEXT NOT NULL,
    "taxableAmount" DECIMAL(18,6) NOT NULL,
    "cgstRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "sgstRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "igstRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "cessRate" DECIMAL(9,4) NOT NULL DEFAULT 0,

    CONSTRAINT "EwayBillItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EwayBillEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "ewayBillId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EwayBillEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EwayBillConfig_companyId_key" ON "EwayBillConfig"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "EwayBill_billNo_key" ON "EwayBill"("billNo");

-- CreateIndex
CREATE INDEX "EwayBill_companyId_status_idx" ON "EwayBill"("companyId", "status");

-- CreateIndex
CREATE INDEX "EwayBill_salesInvoiceId_idx" ON "EwayBill"("salesInvoiceId");

-- CreateIndex
CREATE INDEX "EwayBill_deliveryNoteId_idx" ON "EwayBill"("deliveryNoteId");

-- CreateIndex
CREATE INDEX "EwayBill_ewbNo_idx" ON "EwayBill"("ewbNo");

-- CreateIndex
CREATE INDEX "EwayBillEvent_ewayBillId_createdAt_idx" ON "EwayBillEvent"("ewayBillId", "createdAt");

-- AddForeignKey
ALTER TABLE "EwayBill" ADD CONSTRAINT "EwayBill_salesInvoiceId_fkey" FOREIGN KEY ("salesInvoiceId") REFERENCES "SalesInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EwayBill" ADD CONSTRAINT "EwayBill_deliveryNoteId_fkey" FOREIGN KEY ("deliveryNoteId") REFERENCES "DeliveryNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EwayBillItem" ADD CONSTRAINT "EwayBillItem_ewayBillId_fkey" FOREIGN KEY ("ewayBillId") REFERENCES "EwayBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EwayBillEvent" ADD CONSTRAINT "EwayBillEvent_ewayBillId_fkey" FOREIGN KEY ("ewayBillId") REFERENCES "EwayBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: customers kept their GSTIN in "taxId". Copy values that look like a GSTIN and derive the state code.
UPDATE "Customer"
SET "gstin" = UPPER(TRIM("taxId")), "stateCode" = SUBSTRING(UPPER(TRIM("taxId")) FROM 1 FOR 2)
WHERE "gstin" IS NULL AND UPPER(TRIM("taxId")) ~ '^[0-9]{2}[A-Z0-9]{13}$';
