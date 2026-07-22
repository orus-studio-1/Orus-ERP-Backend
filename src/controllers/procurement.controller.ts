import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generatePONo, generatePurchaseInvoiceNo } from '../utils/generate';
import { ensureLedgerAccount, postToLedger, reverseLedgerForVoucher } from '../services/accounting/ledger.service';
import { Prisma } from '@prisma/client';

// ---- PURCHASE ORDERS ----
export const getPurchaseOrders = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, supplierId, search } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (supplierId) where.supplierId = supplierId;
    if (search) where.orderNo = { contains: search, mode: 'insensitive' };

    const [items, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: { supplier: { select: { name: true, email: true } }, items: { include: { product: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.purchaseOrder.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getPurchaseOrder = async (req: Request, res: Response) => {
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { supplier: true, items: { include: { product: true } }, invoices: true },
    });
    if (!po) return error(res, 'Purchase order not found', 404);
    return success(res, po);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createPurchaseOrder = async (req: Request, res: Response) => {
  try {
    const { supplierId, date, expectedDate, items, notes, terms, currency, discount } = req.body;
    const orderNo = await generatePONo();

    const subtotal = items.reduce((s: number, i: any) => s + i.total, 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.total * (i.taxRate || 0) / 100), 0);
    const total = subtotal + taxAmount - (discount || 0);

    const po = await prisma.purchaseOrder.create({
      data: {
        orderNo, supplierId, date: new Date(date),
        expectedDate: expectedDate ? new Date(expectedDate) : undefined,
        subtotal, taxAmount, total, discount: discount || 0, currency: currency || 'USD', notes, terms,
        items: { create: items },
      },
      include: { supplier: true, items: { include: { product: true } } },
    });
    return success(res, po, 'Purchase order created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updatePurchaseOrderStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const po = await prisma.purchaseOrder.update({ where: { id: req.params.id }, data: { status } });
    return success(res, po, 'Purchase order status updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deletePurchaseOrder = async (req: Request, res: Response) => {
  try {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!po) return error(res, 'Purchase order not found', 404);
    if (po.status !== 'DRAFT') return error(res, 'Only draft orders can be deleted', 400);
    await prisma.purchaseOrder.delete({ where: { id: req.params.id } });
    return success(res, null, 'Purchase order deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- PURCHASE INVOICES ----
export const getPurchaseInvoices = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, supplierId } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (supplierId) where.supplierId = supplierId;

    const [items, total] = await Promise.all([
      prisma.purchaseInvoice.findMany({
        where,
        include: { supplier: { select: { name: true } }, items: { include: { product: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.purchaseInvoice.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createPurchaseInvoice = async (req: Request, res: Response) => {
  try {
    const { supplierId, purchaseOrderId, date, dueDate, items, notes, currency, discount } = req.body;
    const invoiceNo = await generatePurchaseInvoiceNo();

    const subtotal = items.reduce((s: number, i: any) => s + i.total, 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.total * (i.taxRate || 0) / 100), 0);
    const total = subtotal + taxAmount - (discount || 0);

    const inv = await prisma.purchaseInvoice.create({
      data: {
        invoiceNo, supplierId, purchaseOrderId,
        date: new Date(date),
        dueDate: dueDate ? new Date(dueDate) : undefined,
        subtotal, taxAmount, total, discount: discount || 0, currency: currency || 'USD', notes,
        items: { create: items },
      },
      include: { supplier: true, items: { include: { product: true } } },
    });
    return success(res, inv, 'Purchase invoice created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updatePurchaseInvoiceStatus = async (req: Request, res: Response) => {
  try {
    const { status, amountPaid } = req.body;
    const inv = await prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseInvoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
      if (!existing) throw new Error('Purchase invoice not found');
      if (status === 'SENT' || status === 'SUBMITTED') {
        const expense = await ensureLedgerAccount(tx, '5100', 'Purchase Expense / Inventory Received', 'EXPENSE');
        const ap = await ensureLedgerAccount(tx, '2000', 'Accounts Payable', 'LIABILITY', { isDefaultPayable: true });
        const tax = await ensureLedgerAccount(tx, '1300', 'Input Tax Receivable', 'ASSET', { isDefaultTax: true });
        const lines: any[] = [
          { accountId: expense.id, debit: new Prisma.Decimal(existing.subtotal || 0), credit: 0, partyType: 'SUPPLIER', partyId: existing.supplierId, remarks: `${existing.invoiceNo} purchase` },
        ];
        if (Number(existing.taxAmount || 0) > 0) lines.push({ accountId: tax.id, debit: new Prisma.Decimal(existing.taxAmount), credit: 0, partyType: 'SUPPLIER', partyId: existing.supplierId, taxType: 'INPUT', remarks: `${existing.invoiceNo} input tax` });
        lines.push({ accountId: ap.id, debit: 0, credit: new Prisma.Decimal(existing.total || 0), partyType: 'SUPPLIER', partyId: existing.supplierId, remarks: `${existing.invoiceNo} payable` });
        await postToLedger(tx, { voucherType: 'PURCHASE_INVOICE', voucherId: existing.id, voucherNo: existing.invoiceNo, postingDate: existing.date, lines });
      }
      if (status === 'CANCELLED') await reverseLedgerForVoucher(tx, 'PURCHASE_INVOICE', existing.id, new Date());
      return tx.purchaseInvoice.update({ where: { id: req.params.id }, data: { status, amountPaid: amountPaid || undefined } });
    });
    return success(res, inv, 'Purchase invoice updated');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const deletePurchaseInvoice = async (req: Request, res: Response) => {
  try {
    await prisma.purchaseInvoice.delete({ where: { id: req.params.id } });
    return success(res, null, 'Purchase invoice deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
