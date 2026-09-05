-- CreateEnum
CREATE TYPE "ManufacturingBomStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'OBSOLETE');

-- CreateEnum
CREATE TYPE "ManufacturingBomType" AS ENUM ('PRODUCTION', 'ENGINEERING', 'COSTING', 'PHANTOM');

-- CreateEnum
CREATE TYPE "WorkCenterType" AS ENUM ('MACHINE', 'ASSEMBLY', 'INSPECTION', 'MANUAL', 'SUBCONTRACT');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('RUNNING', 'IDLE', 'BREAKDOWN', 'MAINTENANCE', 'SETUP');

-- CreateEnum
CREATE TYPE "ManufacturingInspectionStage" AS ENUM ('NONE', 'FIRST_PIECE', 'IN_PROCESS', 'FINAL', 'PATROL');

-- CreateEnum
CREATE TYPE "ManufacturingWorkOrderStatus" AS ENUM ('DRAFT', 'NOT_STARTED', 'MATERIAL_PENDING', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ManufacturingMaterialStatus" AS ENUM ('NOT_ISSUED', 'PARTIALLY_ISSUED', 'FULLY_ISSUED');

-- CreateEnum
CREATE TYPE "ManufacturingPriority" AS ENUM ('URGENT', 'HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "WorkOrderOperationStatus" AS ENUM ('PENDING', 'SETUP', 'RUNNING', 'PAUSED', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JobCardStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobCardActivityType" AS ENUM ('SETUP', 'RUN', 'IDLE', 'BREAKDOWN', 'REWORK', 'BREAK');

-- CreateEnum
CREATE TYPE "DowntimeCategory" AS ENUM ('BREAKDOWN', 'SETUP', 'MATERIAL_SHORTAGE', 'POWER', 'TOOL_CHANGE', 'QUALITY', 'MANPOWER', 'PLANNED_MAINTENANCE', 'OTHER');

-- CreateTable
CREATE TABLE "Bom" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "bomNumber" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "uomId" TEXT,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "revisionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "status" "ManufacturingBomStatus" NOT NULL DEFAULT 'DRAFT',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supersedesId" UUID,
    "ecnId" TEXT,
    "bomType" "ManufacturingBomType" NOT NULL DEFAULT 'PRODUCTION',
    "routingId" UUID,
    "projectQty" DECIMAL(18,6),
    "rawMaterialCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "operatingCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "overheadCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrapValue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomItem" (
    "id" UUID NOT NULL,
    "bomId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(18,6) NOT NULL,
    "uomId" TEXT,
    "conversionFactor" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "stockQty" DECIMAL(18,6) NOT NULL,
    "scrapPercent" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "wastagePercent" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "isSubcontracted" BOOLEAN NOT NULL DEFAULT false,
    "sourceWarehouseId" TEXT,
    "operationSequence" INTEGER,
    "alternativeItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "includeInManufacturingCost" BOOLEAN NOT NULL DEFAULT true,
    "remarks" TEXT,
    "drawingAttachmentId" TEXT,

    CONSTRAINT "BomItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomScrapItem" (
    "id" UUID NOT NULL,
    "bomId" UUID NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(18,6) NOT NULL,
    "uomId" TEXT,
    "rate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "BomScrapItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomExplosion" (
    "id" UUID NOT NULL,
    "bomId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "parentItemId" TEXT,
    "qtyPerUnit" DECIMAL(18,6) NOT NULL,
    "cumulativeQty" DECIMAL(18,6) NOT NULL,
    "lowLevelCode" INTEGER NOT NULL,
    "path" TEXT NOT NULL,

    CONSTRAINT "BomExplosion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkCenter" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plantId" TEXT,
    "departmentId" TEXT,
    "workCenterType" "WorkCenterType" NOT NULL,
    "capacityPerHour" DECIMAL(18,6) NOT NULL,
    "capacityUom" TEXT,
    "efficiencyPercent" DECIMAL(9,6) NOT NULL DEFAULT 100,
    "hourlyRate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "setupRate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "overheadRate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shiftIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "holidayCalendarId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "machineCode" TEXT NOT NULL,
    "machineName" TEXT NOT NULL,
    "workCenterId" UUID NOT NULL,
    "machineType" TEXT,
    "make" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "installationDate" TIMESTAMP(3),
    "capacityPerHour" DECIMAL(18,6) NOT NULL,
    "status" "MachineStatus" NOT NULL DEFAULT 'IDLE',
    "lastMaintenanceDate" TIMESTAMP(3),
    "nextMaintenanceDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingOperation" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "operationCode" TEXT NOT NULL,
    "operationName" TEXT NOT NULL,
    "defaultWorkCenterId" UUID,
    "description" TEXT,
    "isInspectionRequired" BOOLEAN NOT NULL DEFAULT false,
    "isOutsourced" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManufacturingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Routing" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "routingNumber" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "bomId" UUID,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "ManufacturingBomStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Routing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingOperation" (
    "id" UUID NOT NULL,
    "routingId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "operationId" UUID NOT NULL,
    "workCenterId" UUID NOT NULL,
    "machineId" UUID,
    "description" TEXT,
    "setupTimeMinutes" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cycleTimeMinutes" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "moveTimeMinutes" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "queueTimeMinutes" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "batchSize" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "operatorsRequired" INTEGER NOT NULL DEFAULT 1,
    "skillRequired" TEXT,
    "inspectionStage" "ManufacturingInspectionStage" NOT NULL DEFAULT 'NONE',
    "qualityTemplateId" TEXT,
    "isOutsourced" BOOLEAN NOT NULL DEFAULT false,
    "subcontractVendorId" TEXT,
    "subcontractRate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "drawingAttachmentId" TEXT,
    "workInstructionAttachmentId" TEXT,

    CONSTRAINT "RoutingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DowntimeReason" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "DowntimeCategory" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DowntimeReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingWorkOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "woNumber" TEXT NOT NULL,
    "woDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" TEXT NOT NULL,
    "bomId" UUID NOT NULL,
    "routingId" UUID NOT NULL,
    "salesOrderId" TEXT,
    "salesOrderItemId" TEXT,
    "productionPlanId" TEXT,
    "qtyToProduce" DECIMAL(18,6) NOT NULL,
    "producedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "scrapQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rejectedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "pendingQty" DECIMAL(18,6) NOT NULL,
    "uomId" TEXT,
    "warehouseId" TEXT NOT NULL,
    "wipWarehouseId" TEXT NOT NULL,
    "sourceWarehouseId" TEXT NOT NULL,
    "plannedStartDate" TIMESTAMP(3),
    "plannedEndDate" TIMESTAMP(3),
    "actualStartDate" TIMESTAMP(3),
    "actualEndDate" TIMESTAMP(3),
    "priority" "ManufacturingPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "ManufacturingWorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "materialStatus" "ManufacturingMaterialStatus" NOT NULL DEFAULT 'NOT_ISSUED',
    "plannedCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "actualCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "costVariance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "customerId" TEXT,
    "customerPoNumber" TEXT,
    "remarks" TEXT,
    "bomSnapshot" JSONB,
    "routingSnapshot" JSONB,
    "holdReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManufacturingWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingWorkOrderItem" (
    "id" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "itemId" TEXT NOT NULL,
    "requiredQty" DECIMAL(18,6) NOT NULL,
    "issuedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "consumedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "returnedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "uomId" TEXT,
    "sourceWarehouseId" TEXT NOT NULL,
    "availableQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "shortageQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "batchId" TEXT,
    "serialNoId" TEXT,

    CONSTRAINT "ManufacturingWorkOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingWorkOrderOperation" (
    "id" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "operationId" UUID NOT NULL,
    "workCenterId" UUID NOT NULL,
    "machineId" UUID,
    "plannedStartAt" TIMESTAMP(3),
    "plannedEndAt" TIMESTAMP(3),
    "actualStartAt" TIMESTAMP(3),
    "actualEndAt" TIMESTAMP(3),
    "plannedQty" DECIMAL(18,6) NOT NULL,
    "completedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rejectedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "reworkQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "scrapQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "setupTimeActual" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "runTimeActual" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "downtimeMinutes" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "status" "WorkOrderOperationStatus" NOT NULL DEFAULT 'PENDING',
    "operatorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inspectionStage" "ManufacturingInspectionStage" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "ManufacturingWorkOrderOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCard" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "companyId" TEXT NOT NULL,
    "jobCardNumber" TEXT NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderOperationId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "workCenterId" UUID NOT NULL,
    "machineId" UUID,
    "shiftId" TEXT,
    "plannedQty" DECIMAL(18,6) NOT NULL,
    "completedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rejectedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "reworkQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "scrapQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalTimeMinutes" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "operatorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supervisorId" TEXT,
    "status" "JobCardStatus" NOT NULL DEFAULT 'OPEN',
    "firstPieceApprovedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCardTimeLog" (
    "id" UUID NOT NULL,
    "jobCardId" UUID NOT NULL,
    "fromTime" TIMESTAMP(3) NOT NULL,
    "toTime" TIMESTAMP(3),
    "activityType" "JobCardActivityType" NOT NULL,
    "completedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "operatorId" TEXT,
    "downtimeReasonId" UUID,
    "remarks" TEXT,

    CONSTRAINT "JobCardTimeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bom_tenantId_companyId_itemId_status_idx" ON "Bom"("tenantId", "companyId", "itemId", "status");

-- CreateIndex
CREATE INDEX "Bom_supersedesId_idx" ON "Bom"("supersedesId");

-- CreateIndex
CREATE UNIQUE INDEX "Bom_companyId_bomNumber_revisionNumber_key" ON "Bom"("companyId", "bomNumber", "revisionNumber");

-- CreateIndex
CREATE INDEX "BomItem_itemId_idx" ON "BomItem"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "BomItem_bomId_lineNumber_key" ON "BomItem"("bomId", "lineNumber");

-- CreateIndex
CREATE INDEX "BomExplosion_bomId_level_idx" ON "BomExplosion"("bomId", "level");

-- CreateIndex
CREATE INDEX "BomExplosion_itemId_idx" ON "BomExplosion"("itemId");

-- CreateIndex
CREATE INDEX "WorkCenter_tenantId_companyId_isActive_idx" ON "WorkCenter"("tenantId", "companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WorkCenter_companyId_code_key" ON "WorkCenter"("companyId", "code");

-- CreateIndex
CREATE INDEX "Machine_workCenterId_status_idx" ON "Machine"("workCenterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_companyId_machineCode_key" ON "Machine"("companyId", "machineCode");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingOperation_companyId_operationCode_key" ON "ManufacturingOperation"("companyId", "operationCode");

-- CreateIndex
CREATE INDEX "Routing_itemId_status_idx" ON "Routing"("itemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Routing_companyId_routingNumber_revisionNumber_key" ON "Routing"("companyId", "routingNumber", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingOperation_routingId_sequence_key" ON "RoutingOperation"("routingId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DowntimeReason_companyId_code_key" ON "DowntimeReason"("companyId", "code");

-- CreateIndex
CREATE INDEX "ManufacturingWorkOrder_tenantId_companyId_status_idx" ON "ManufacturingWorkOrder"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "ManufacturingWorkOrder_salesOrderId_idx" ON "ManufacturingWorkOrder"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingWorkOrder_companyId_woNumber_key" ON "ManufacturingWorkOrder"("companyId", "woNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingWorkOrderItem_workOrderId_itemId_sourceWarehou_key" ON "ManufacturingWorkOrderItem"("workOrderId", "itemId", "sourceWarehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingWorkOrderOperation_workOrderId_sequence_key" ON "ManufacturingWorkOrderOperation"("workOrderId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "JobCard_workOrderOperationId_key" ON "JobCard"("workOrderOperationId");

-- CreateIndex
CREATE INDEX "JobCard_tenantId_companyId_status_idx" ON "JobCard"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "JobCard_machineId_status_idx" ON "JobCard"("machineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobCard_companyId_jobCardNumber_key" ON "JobCard"("companyId", "jobCardNumber");

-- CreateIndex
CREATE INDEX "JobCardTimeLog_jobCardId_fromTime_idx" ON "JobCardTimeLog"("jobCardId", "fromTime");

-- AddForeignKey
ALTER TABLE "BomItem" ADD CONSTRAINT "BomItem_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomScrapItem" ADD CONSTRAINT "BomScrapItem_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomExplosion" ADD CONSTRAINT "BomExplosion_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_routingId_fkey" FOREIGN KEY ("routingId") REFERENCES "Routing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingWorkOrderItem" ADD CONSTRAINT "ManufacturingWorkOrderItem_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "ManufacturingWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingWorkOrderOperation" ADD CONSTRAINT "ManufacturingWorkOrderOperation_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "ManufacturingWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "ManufacturingWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_workOrderOperationId_fkey" FOREIGN KEY ("workOrderOperationId") REFERENCES "ManufacturingWorkOrderOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCardTimeLog" ADD CONSTRAINT "JobCardTimeLog_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Manufacturing reservations reuse the central stock reservation ledger.
ALTER TABLE "StockReservation" ALTER COLUMN "salesOrderId" DROP NOT NULL;
ALTER TABLE "StockReservation" ALTER COLUMN "salesOrderItemId" DROP NOT NULL;
ALTER TABLE "StockReservation" ADD COLUMN "workOrderId" UUID;
CREATE INDEX "StockReservation_workOrderId_idx" ON "StockReservation"("workOrderId");
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "ManufacturingWorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
