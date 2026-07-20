import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getStockBalanceReport = async (req: Request, res: Response) => {
  try {
    const { productId, warehouseId, lowStock } = req.query as any;
    const where: any = {};
    if (productId) where.productId = productId;
    if (warehouseId) where.warehouseId = warehouseId;
    const levels = await prisma.stockLevel.findMany({ where, include: { product: { include: { unit: true, category: true } }, warehouse: true }, orderBy: { updatedAt: 'desc' } });
    const rows = levels
      .map((level: any) => ({
        productId: level.productId,
        sku: level.product.sku,
        productName: level.product.name,
        category: level.product.category?.name,
        warehouseId: level.warehouseId,
        warehouse: level.warehouse.name,
        actualQty: Number(level.quantity || 0),
        reservedQty: Number(level.reservedQty || 0),
        availableQty: Number(level.quantity || 0) - Number(level.reservedQty || 0),
        reorderLevel: Number(level.product.reorderLevel || level.product.minStockLevel || 0),
        stockUom: level.product.unit?.symbol,
      }))
      .filter((row) => lowStock === 'true' ? row.availableQty <= row.reorderLevel : true);
    return success(res, { rows, totals: rows.reduce((acc, row) => ({ actualQty: acc.actualQty + row.actualQty, reservedQty: acc.reservedQty + row.reservedQty, availableQty: acc.availableQty + row.availableQty }), { actualQty: 0, reservedQty: 0, availableQty: 0 }) });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getStockLedgerReport = async (req: Request, res: Response) => {
  try {
    const { productId, warehouseId, voucherType, fromDate, toDate } = req.query as any;
    const where: any = {};
    if (productId) where.productId = productId;
    if (warehouseId) where.warehouseId = warehouseId;
    if (voucherType) where.voucherType = voucherType;
    if (fromDate || toDate) where.postingDate = { ...(fromDate ? { gte: new Date(fromDate) } : {}), ...(toDate ? { lte: new Date(toDate) } : {}) };
    const rows = await prisma.stockLedgerEntry.findMany({
      where,
      include: { product: { select: { sku: true, name: true } }, warehouse: { select: { name: true, code: true } } },
      orderBy: [{ postingDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return success(res, rows);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getProjectedStockReport = async (_req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true, type: 'PRODUCT' },
      include: { stockLevels: { include: { warehouse: true } }, salesOrderItems: { include: { salesOrder: true } } },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const rows = products.flatMap((product: any) => product.stockLevels.map((level: any) => {
      const openDemand = product.salesOrderItems
        .filter((item: any) => ['CONFIRMED', 'PROCESSING'].includes(item.salesOrder.status))
        .reduce((sum: number, item: any) => sum + Math.max(0, Number(item.quantity) - Number(item.deliveredQty || 0)), 0);
      return {
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        warehouseId: level.warehouseId,
        warehouse: level.warehouse.name,
        actualQty: Number(level.quantity || 0),
        reservedQty: Number(level.reservedQty || 0),
        openSalesOrderQty: openDemand,
        projectedQty: Number(level.quantity || 0) - openDemand,
      };
    }));
    return success(res, rows);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getReservedStockReport = async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.stockReservation.findMany({
      where: { status: { in: ['ACTIVE', 'PARTIAL'] } },
      include: { product: { select: { sku: true, name: true } }, warehouse: { select: { name: true } }, salesOrder: { select: { orderNo: true, customer: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, rows.map((row: any) => ({
      product: row.product,
      warehouse: row.warehouse,
      salesOrder: row.salesOrder,
      reservedQty: Number(row.reservedQty),
      fulfilledQty: Number(row.fulfilledQty),
      openQty: Number(row.reservedQty) - Number(row.fulfilledQty),
      status: row.status,
    })));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getWarehouseValuationReport = async (_req: Request, res: Response) => {
  try {
    const levels = await prisma.stockLevel.findMany({ include: { product: true, warehouse: true } });
    const rows = levels.map((level: any) => ({
      warehouseId: level.warehouseId,
      warehouse: level.warehouse.name,
      productId: level.productId,
      sku: level.product.sku,
      productName: level.product.name,
      quantity: Number(level.quantity || 0),
      valuationRate: Number(level.product.costPrice || 0),
      stockValue: Number(level.quantity || 0) * Number(level.product.costPrice || 0),
    }));
    return success(res, { rows, totalValue: rows.reduce((sum, row) => sum + row.stockValue, 0) });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getItemWiseSalesReport = async (_req: Request, res: Response) => {
  try {
    const items = await prisma.salesInvoiceItem.findMany({
      include: { product: { select: { sku: true, name: true, costPrice: true } }, salesInvoice: { select: { status: true, invoiceNo: true } } },
    });
    const map = new Map<string, any>();
    items.filter((item: any) => item.salesInvoice.status === 'SUBMITTED').forEach((item: any) => {
      const row = map.get(item.productId) || { productId: item.productId, sku: item.product?.sku, productName: item.product?.name, quantity: 0, revenue: 0, cost: 0, grossProfit: 0 };
      const qty = Number(item.quantity || 0);
      const revenue = Number(item.netAmount || item.total || 0);
      const cost = qty * Number(item.product?.costPrice || 0);
      row.quantity += qty;
      row.revenue += revenue;
      row.cost += cost;
      row.grossProfit += revenue - cost;
      map.set(item.productId, row);
    });
    return success(res, Array.from(map.values()));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getGrossProfitReport = async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.salesOrder.findMany({
      include: { customer: { select: { name: true } }, items: { include: { product: true } }, invoices: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return success(res, rows.map((order: any) => {
      const cost = order.items.reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.product?.costPrice || 0), 0);
      const revenue = Number(order.total || 0);
      return { orderNo: order.orderNo, customer: order.customer?.name, revenue, cost, grossProfit: revenue - cost, grossMargin: revenue ? ((revenue - cost) / revenue) * 100 : 0 };
    }));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getSlowMovingStockReport = async (_req: Request, res: Response) => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const levels = await prisma.stockLevel.findMany({ where: { quantity: { gt: 0 } }, include: { product: true, warehouse: true } });
    const rows = [];
    for (const level of levels as any[]) {
      const lastIssue = await prisma.stockLedgerEntry.findFirst({
        where: { productId: level.productId, warehouseId: level.warehouseId, actualQty: { lt: 0 } },
        orderBy: { postingDate: 'desc' },
      });
      if (!lastIssue || lastIssue.postingDate < cutoff) {
        rows.push({ sku: level.product.sku, productName: level.product.name, warehouse: level.warehouse.name, quantity: Number(level.quantity), lastIssueDate: lastIssue?.postingDate || null, ageDays: lastIssue ? Math.floor((Date.now() - lastIssue.postingDate.getTime()) / 86400000) : null });
      }
    }
    return success(res, rows);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
