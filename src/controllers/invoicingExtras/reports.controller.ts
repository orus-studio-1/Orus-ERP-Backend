import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { serializeInvoice, serializeMoney } from '../../utils/invoice';

export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const { entityType, entityId, invoiceId, deliveryNoteId, creditNoteId } = req.query as any;
    const where: any = {};
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (invoiceId) where.invoiceId = invoiceId;
    if (deliveryNoteId) where.deliveryNoteId = deliveryNoteId;
    if (creditNoteId) where.creditNoteId = creditNoteId;
    const logs = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    return success(res, logs);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getOutstandingInvoices = async (_req: Request, res: Response) => {
  try {
    const invoices = await prisma.salesInvoice.findMany({
      where: { status: 'SUBMITTED', outstandingAmount: { gt: 0 } },
      include: { customer: { select: { name: true } } },
      orderBy: { dueDate: 'asc' },
    });
    return success(res, invoices.map(serializeInvoice));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getRevenueByCustomer = async (_req: Request, res: Response) => {
  try {
    const invoices = await prisma.salesInvoice.findMany({ where: { status: 'SUBMITTED' }, include: { customer: { select: { id: true, name: true } } } });
    const rows = new Map<string, any>();
    invoices.forEach((invoice) => {
      const key = invoice.customerId;
      const row = rows.get(key) || { customerId: key, customerName: invoice.customer?.name || 'Unknown', revenue: 0, invoiceCount: 0 };
      row.revenue += serializeMoney(invoice.grandTotal);
      row.invoiceCount += 1;
      rows.set(key, row);
    });
    return success(res, Array.from(rows.values()));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getRevenueByItem = async (_req: Request, res: Response) => {
  try {
    const items = await prisma.salesInvoiceItem.findMany({ include: { product: { select: { sku: true, name: true } }, salesInvoice: { select: { status: true } } } });
    const rows = new Map<string, any>();
    items.filter((item: any) => item.salesInvoice.status === 'SUBMITTED').forEach((item: any) => {
      const row = rows.get(item.productId) || { productId: item.productId, sku: item.product?.sku, name: item.product?.name, quantity: 0, revenue: 0 };
      row.quantity += serializeMoney(item.quantity);
      row.revenue += serializeMoney(item.total);
      rows.set(item.productId, row);
    });
    return success(res, Array.from(rows.values()));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getRevenueByPeriod = async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT DATE_TRUNC('month', "date") AS period, SUM("grandTotal") AS revenue, COUNT(*)::int AS "invoiceCount"
      FROM "SalesInvoice"
      WHERE status = 'SUBMITTED'
      GROUP BY DATE_TRUNC('month', "date")
      ORDER BY period ASC
    `;
    return success(res, rows);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
