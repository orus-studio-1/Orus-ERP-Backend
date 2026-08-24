import { Request, Response } from 'express';
import { Prisma, StockEntryPurpose } from '@prisma/client';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { postStockLedger, postStockTransfer } from '../../services/inventory/stockLedger.service';

const include = {
  fromWarehouse: true,
  toWarehouse: true,
  items: { include: { product: true, warehouse: true } },
};

async function nextStockEntryNo(tx: any) {
  let series = await tx.numberingSeries.findFirst({
    where: { documentType: 'STOCK_ENTRY', isActive: true, isDefault: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!series) {
    series = await tx.numberingSeries.create({
      data: {
        documentType: 'STOCK_ENTRY',
        name: 'STE-DEFAULT',
        pattern: `STE-${new Date().getFullYear()}-#####`,
        prefix: 'STE',
        digits: 5,
        isDefault: true,
      },
    });
  }

  const currentYear = new Date().getFullYear();
  let maxSeq = Number(series.current) || 0;

  // Query highest existing sequence number directly from database table
  try {
    const lastEntry: any = await tx.$queryRawUnsafe(
      `SELECT "entryNo" FROM "StockEntry" WHERE "entryNo" LIKE $1 ORDER BY "entryNo" DESC LIMIT 1`,
      `STE-${currentYear}-%`
    );
    if (Array.isArray(lastEntry) && lastEntry.length > 0 && lastEntry[0]?.entryNo) {
      const parts = String(lastEntry[0].entryNo).split('-');
      const lastNum = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastNum) && lastNum >= maxSeq) {
        maxSeq = lastNum;
      }
    }
  } catch {}

  let entryNo = '';
  let attempts = 0;
  while (attempts < 100) {
    attempts++;
    maxSeq++;
    const digits = '#'.repeat(series.digits || 5);
    const padded = String(maxSeq).padStart(series.digits || 5, '0');
    let pattern = series.pattern || `STE-${currentYear}-#####`;
    pattern = pattern
      .replace('.YYYY.', String(currentYear))
      .replace('{YYYY}', String(currentYear))
      .replace('{YEAR}', String(currentYear))
      .replace('{FY}', String(currentYear))
      .replace('{SEQ}', padded)
      .replace(digits, padded);

    entryNo = pattern;
    if (!entryNo.includes(padded)) {
      entryNo = `${entryNo}-${padded}`;
    }

    try {
      const existsRaw: any = await tx.$queryRawUnsafe(
        `SELECT count(*)::int as count FROM "StockEntry" WHERE "entryNo" = $1`,
        entryNo
      );
      const count = Array.isArray(existsRaw) && existsRaw[0]?.count ? Number(existsRaw[0].count) : 0;
      if (count === 0) {
        await tx.numberingSeries.update({
          where: { id: series.id },
          data: { current: maxSeq },
        }).catch(() => null);
        break;
      }
    } catch {
      break;
    }
  }

  // Guaranteed unique timestamp fallback
  try {
    const finalCheck: any = await tx.$queryRawUnsafe(
      `SELECT count(*)::int as count FROM "StockEntry" WHERE "entryNo" = $1`,
      entryNo
    );
    const finalCount = Array.isArray(finalCheck) && finalCheck[0]?.count ? Number(finalCheck[0].count) : 0;
    if (finalCount > 0) {
      entryNo = `STE-${currentYear}-${Date.now().toString().slice(-6)}`;
    }
  } catch {}

  return entryNo;
}

function itemData(items: any[] = []) {
  return items.map((item) => ({
    productId: item.productId,
    warehouseId: item.warehouseId || undefined,
    quantity: new Prisma.Decimal(item.quantity || 0),
    valuationRate: new Prisma.Decimal(item.valuationRate || item.rate || 0),
    batchId: item.batchId || undefined,
    serialNoId: item.serialNoId || undefined,
    remarks: item.remarks || undefined,
  }));
}

async function postStockEntry(tx: any, entry: any, reverse = false) {
  const sign = reverse ? -1 : 1;
  for (const item of entry.items) {
    const qty = new Prisma.Decimal(item.quantity).mul(sign);
    if (entry.purpose === 'REPACK') {
      const targetWarehouse = item.warehouseId || entry.toWarehouseId || entry.fromWarehouseId;
      if (!targetWarehouse) throw new Error('Warehouse is required for repack item');
      await postStockLedger(tx, {
        productId: item.productId,
        warehouseId: targetWarehouse,
        actualQty: qty,
        rate: item.valuationRate,
        postingDate: entry.postingDate,
        voucherType: 'STOCK_ENTRY',
        voucherId: entry.id,
        voucherNo: entry.entryNo,
        remarks: reverse ? `Reversal of repack ${entry.entryNo}` : entry.remarks,
        batchId: item.batchId,
        serialNoId: item.serialNoId,
      });
      continue;
    }
    if (entry.purpose === 'STOCK_RECONCILIATION' || entry.purpose === 'OPENING_STOCK') {
      const targetWarehouse = item.warehouseId || entry.toWarehouseId || entry.fromWarehouseId;
      if (!targetWarehouse) throw new Error('Warehouse is required for stock reconciliation item');
      const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: item.productId, warehouseId: targetWarehouse } } });
      const currentQty = new Prisma.Decimal(level?.quantity || 0);
      const targetQty = reverse ? currentQty.minus(qty.minus(currentQty)) : qty;
      const diffQty = reverse ? qty.neg() : targetQty.minus(currentQty);
      await postStockLedger(tx, {
        productId: item.productId,
        warehouseId: targetWarehouse,
        actualQty: diffQty,
        rate: item.valuationRate,
        postingDate: entry.postingDate,
        voucherType: 'STOCK_ENTRY',
        voucherId: entry.id,
        voucherNo: entry.entryNo,
        remarks: reverse ? `Reversal of ${entry.entryNo}` : entry.remarks,
        batchId: item.batchId,
        serialNoId: item.serialNoId,
      });
      continue;
    }
    if (entry.purpose === 'MATERIAL_TRANSFER') {
      if (!entry.fromWarehouseId || !entry.toWarehouseId) throw new Error('Transfer requires source and target warehouse');
      await postStockTransfer(tx, {
        productId: item.productId,
        fromWarehouseId: reverse ? entry.toWarehouseId : entry.fromWarehouseId,
        toWarehouseId: reverse ? entry.fromWarehouseId : entry.toWarehouseId,
        quantity: item.quantity,
        rate: item.valuationRate,
        postingDate: entry.postingDate,
        voucherType: 'STOCK_ENTRY',
        voucherId: entry.id,
        voucherNo: entry.entryNo,
        remarks: reverse ? 'Reversal of stock transfer' : entry.remarks,
      });
      continue;
    }
    const targetWarehouse = item.warehouseId || entry.toWarehouseId || entry.fromWarehouseId;
    if (!targetWarehouse) throw new Error('Warehouse is required for stock entry item');
    const outgoing = ['MATERIAL_ISSUE', 'SCRAP', 'SUPPLIER_RETURN', 'JOB_WORK_ISSUE'].includes(entry.purpose);
    await postStockLedger(tx, {
      productId: item.productId,
      warehouseId: targetWarehouse,
      actualQty: outgoing ? qty.neg() : qty,
      rate: item.valuationRate,
      postingDate: entry.postingDate,
      voucherType: 'STOCK_ENTRY',
      voucherId: entry.id,
      voucherNo: entry.entryNo,
      remarks: reverse ? `Reversal of ${entry.entryNo}` : entry.remarks,
      batchId: item.batchId,
      serialNoId: item.serialNoId,
    });
  }
}

async function reverseStockEntry(tx: any, entry: any) {
  const ledgerRows = await tx.stockLedgerEntry.findMany({ where: { voucherType: 'STOCK_ENTRY', voucherId: entry.id, isCancelled: false } });
  for (const row of ledgerRows) {
    await postStockLedger(tx, {
      productId: row.productId,
      warehouseId: row.warehouseId,
      actualQty: new Prisma.Decimal(row.actualQty).neg(),
      rate: row.valuationRate,
      postingDate: new Date(),
      voucherType: 'STOCK_ENTRY',
      voucherId: entry.id,
      voucherNo: `${entry.entryNo}-CANCEL`,
      remarks: `Reversal of ${entry.entryNo}`,
      batchId: row.batchId,
      serialNoId: row.serialNoId,
      reversalOfId: row.id,
    });
    await tx.stockLedgerEntry.update({ where: { id: row.id }, data: { isCancelled: true } });
  }
}

export const getStockEntries = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, purpose } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (purpose) where.purpose = purpose;
    const [items, total] = await Promise.all([
      prisma.stockEntry.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.stockEntry.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getStockEntry = async (req: Request, res: Response) => {
  try {
    const entry = await prisma.stockEntry.findUnique({ where: { id: req.params.id }, include });
    if (!entry) return error(res, 'Stock entry not found', 404);
    return success(res, entry);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createStockEntry = async (req: Request, res: Response) => {
  try {
    const { postingDate, fromWarehouseId, toWarehouseId, remarks, items = [] } = req.body;
    const rawPurpose = req.body.purpose || req.body.type || req.body.entryType || 'MATERIAL_RECEIPT';
    const validPurposes: string[] = [
      'MATERIAL_RECEIPT',
      'MATERIAL_ISSUE',
      'MATERIAL_TRANSFER',
      'STOCK_RECONCILIATION',
      'OPENING_STOCK',
      'REPACK',
      'MANUFACTURE',
      'SCRAP',
      'CUSTOMER_RETURN',
      'SUPPLIER_RETURN',
      'JOB_WORK_ISSUE',
      'JOB_WORK_RECEIPT',
    ];
    const normalizedPurpose = String(rawPurpose).toUpperCase().replace(/[-\s]+/g, '_');
    const purpose: StockEntryPurpose = (validPurposes.includes(normalizedPurpose) ? normalizedPurpose : 'MATERIAL_RECEIPT') as StockEntryPurpose;

    if (!items.length) return error(res, 'At least one stock entry item is required', 400);
    const entry = await prisma.$transaction(async (tx) => tx.stockEntry.create({
      data: {
        entryNo: await nextStockEntryNo(tx),
        purpose,
        companyId: req.body.companyId || (req as any).user?.companyId || undefined,
        postingDate: postingDate ? new Date(postingDate) : new Date(),
        fromWarehouseId: fromWarehouseId || undefined,
        toWarehouseId: toWarehouseId || undefined,
        remarks: remarks || undefined,
        items: { create: itemData(items) },
      },
      include,
    }));
    return success(res, entry, 'Stock entry created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateStockEntryStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const entry = await prisma.$transaction(async (tx) => {
      const existing = await tx.stockEntry.findUnique({ where: { id: req.params.id }, include });
      if (!existing) throw new Error('Stock entry not found');
      if (status === 'SUBMITTED') {
        if (existing.status !== 'DRAFT') throw new Error('Only draft stock entries can be submitted');
        await postStockEntry(tx, existing);
        return tx.stockEntry.update({ where: { id: existing.id }, data: { status: 'SUBMITTED', submittedAt: new Date() }, include });
      }
      if (status === 'CANCELLED') {
        if (existing.status !== 'SUBMITTED') throw new Error('Only submitted stock entries can be cancelled');
        await reverseStockEntry(tx, existing);
        return tx.stockEntry.update({ where: { id: existing.id }, data: { status: 'CANCELLED', cancelledAt: new Date() }, include });
      }
      throw new Error('Unsupported stock entry transition');
    });
    return success(res, entry, 'Stock entry updated');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const amendStockEntry = async (req: Request, res: Response) => {
  try {
    const amended = await prisma.$transaction(async (tx: any) => {
      const source = await tx.stockEntry.findUnique({ where: { id: req.params.id }, include: { items: true } });
      if (!source) throw new Error('Stock entry not found');
      if (source.status !== 'CANCELLED') throw new Error('Only cancelled stock entries can be amended');
      const s: any = source;
      return tx.stockEntry.create({
        data: {
          entryNo: await nextStockEntryNo(tx),
          companyId: s.companyId || undefined,
          purpose: s.purpose,
          postingDate: new Date(),
          fromWarehouseId: s.fromWarehouseId || undefined,
          toWarehouseId: s.toWarehouseId || undefined,
          remarks: s.remarks || undefined,
          amendedFromId: s.id,
          revisionNo: (s.revisionNo || 1) + 1,
          sourceDocumentType: s.sourceDocumentType || undefined,
          sourceDocumentId: s.sourceDocumentId || undefined,
          items: {
            create: (s.items || []).map((item: any) => ({
              productId: item.productId,
              warehouseId: item.warehouseId || undefined,
              quantity: item.quantity,
              valuationRate: item.valuationRate,
              batchId: item.batchId || undefined,
              serialNoId: item.serialNoId || undefined,
              remarks: item.remarks || undefined,
            })),
          },
        },
        include,
      });
    });
    return success(res, amended, 'Stock entry amendment created', 201);
  } catch (err: any) {
    return error(res, err.message || 'Could not amend stock entry', err.message?.includes('not found') ? 404 : 400);
  }
};
