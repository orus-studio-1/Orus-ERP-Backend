import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { calculateInvoiceTotals, deriveInvoicePaymentStatus, serializeInvoice, serializeMoney } from '../utils/invoice';
import { audit, postStockOut, recalculateInvoiceAllocations, resolveAndSnapshotInvoiceTaxes } from '../utils/erp';
import { renderInvoicePdf } from '../utils/pdf';

async function nextDocumentNo(tx: any, documentType: 'SALES_INVOICE' | 'PAYMENT_ENTRY' | 'CREDIT_NOTE') {
  let series = await tx.numberingSeries.findFirst({
    where: { documentType, isActive: true, isDefault: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!series) {
    const prefix = documentType === 'SALES_INVOICE' ? 'INV' : documentType === 'PAYMENT_ENTRY' ? 'PAY' : 'CN';
    series = await tx.numberingSeries.create({
      data: {
        documentType,
        name: `${prefix}-DEFAULT`,
        pattern: `${prefix}-${new Date().getFullYear()}-#####`,
        prefix,
        digits: 5,
        isDefault: true,
      },
    });
  }

  const updated = await tx.numberingSeries.update({
    where: { id: series.id },
    data: { current: { increment: 1 } },
  });

  const digits = '#'.repeat(updated.digits);
  const padded = String(updated.current).padStart(updated.digits, '0');
  return updated.pattern.replace(digits, padded);
}

function apiStatusToWhere(status?: string) {
  if (!status) return {};
  if (status === 'DRAFT' || status === 'CANCELLED') return { status };
  if (status === 'SENT') return { status: 'SUBMITTED', paymentStatus: 'UNPAID' };
  return { status: 'SUBMITTED', paymentStatus: status };
}

function invoiceResponse(invoice: any) {
  const serialized = serializeInvoice(invoice);
  if (serialized.status === 'SUBMITTED') {
    serialized.status = serialized.paymentStatus === 'UNPAID' ? 'SENT' : serialized.paymentStatus;
  }
  return serialized;
}

async function normalizeInvoiceItems(tx: any, items: any[]) {
  const normalized = [];

  for (const item of items) {
    const itemCode = String(item.itemCode || '').trim();
    let product = item.productId ? await tx.product.findUnique({ where: { id: item.productId } }) : null;

    if (!product && itemCode) {
      product = await tx.product.findFirst({
        where: { sku: itemCode },
      });
    }

    if (!product) {
      const fallbackSku = itemCode || `MISC-${Date.now()}-${normalized.length + 1}`;
      const fallbackName = item.description || itemCode || 'Miscellaneous item';
      product = await tx.product.create({
        data: {
          sku: fallbackSku,
          name: fallbackName,
          description: item.description,
          type: 'SERVICE',
          salePrice: new Prisma.Decimal(item.unitPrice ?? item.rate ?? 0),
          taxRate: new Prisma.Decimal(item.taxRate ?? 0),
          isActive: true,
        },
      });
    }

    normalized.push({
      ...item,
      productId: product.id,
      itemCode: itemCode || product.sku,
      description: item.description || product.description || product.name,
      unitPrice: item.unitPrice ?? item.rate ?? product.salePrice,
      taxRate: item.taxRate ?? product.taxRate ?? 0,
    });
  }

  return normalized;
}

async function recalculateInvoicePayment(tx: any, invoiceId: string) {
  await recalculateInvoiceAllocations(tx, invoiceId);
  return tx.salesInvoice.findUnique({ where: { id: invoiceId }, include: invoiceInclude });
}

const invoiceInclude = {
  customer: { select: { id: true, name: true, email: true, currency: true } },
  salesOrder: { select: { id: true, orderNo: true } },
  deliveryNote: { select: { id: true, deliveryNo: true, status: true } },
  items: { include: { product: { select: { id: true, sku: true, name: true, type: true } }, taxes: true } },
  taxes: true,
  payments: { orderBy: { date: 'desc' as const } },
  paymentAllocations: { include: { paymentEntry: { select: { id: true, paymentNo: true, date: true, method: true, reference: true } } } },
  auditLogs: { orderBy: { createdAt: 'desc' as const }, take: 30 },
};

async function ensureAccount(tx: any, code: string, name: string, type: 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | 'EQUITY') {
  return tx.account.upsert({
    where: { code },
    update: {},
    create: { code, name, type, currency: 'USD' },
  });
}

async function postInvoiceLedger(tx: any, invoice: any, isReversal = false) {
  const ar = await ensureAccount(tx, '1100', 'Accounts Receivable', 'ASSET');
  const sales = await ensureAccount(tx, '4000', 'Sales Revenue', 'REVENUE');
  const tax = await ensureAccount(tx, '2100', 'Tax Payable', 'LIABILITY');
  const factor = isReversal ? -1 : 1;
  const entries = [
    {
      accountId: ar.id,
      customerId: invoice.customerId,
      voucherType: isReversal ? 'CANCELLATION' : 'SALES_INVOICE',
      voucherId: invoice.id,
      invoiceId: invoice.id,
      debit: invoice.grandTotal.mul(factor),
      credit: new Prisma.Decimal(0),
      currency: invoice.currency,
      remarks: `${isReversal ? 'Reverse ' : ''}${invoice.invoiceNo} receivable`,
      isReversal,
    },
    {
      accountId: sales.id,
      customerId: invoice.customerId,
      voucherType: isReversal ? 'CANCELLATION' : 'SALES_INVOICE',
      voucherId: invoice.id,
      invoiceId: invoice.id,
      debit: new Prisma.Decimal(0),
      credit: invoice.subtotal.mul(factor),
      currency: invoice.currency,
      remarks: `${isReversal ? 'Reverse ' : ''}${invoice.invoiceNo} revenue`,
      isReversal,
    },
  ];
  if (invoice.taxAmount.gt(0)) {
    entries.push({
      accountId: tax.id,
      customerId: invoice.customerId,
      voucherType: isReversal ? 'CANCELLATION' : 'SALES_INVOICE',
      voucherId: invoice.id,
      invoiceId: invoice.id,
      debit: new Prisma.Decimal(0),
      credit: invoice.taxAmount.mul(factor),
      currency: invoice.currency,
      remarks: `${isReversal ? 'Reverse ' : ''}${invoice.invoiceNo} tax`,
      isReversal,
    });
  }
  await tx.generalLedgerEntry.createMany({ data: entries });
}

async function postPaymentLedger(tx: any, payment: any, invoice: any) {
  const bank = await ensureAccount(tx, '1000', 'Bank / Cash', 'ASSET');
  const ar = await ensureAccount(tx, '1100', 'Accounts Receivable', 'ASSET');
  await tx.generalLedgerEntry.createMany({
    data: [
      {
        postingDate: payment.date,
        accountId: bank.id,
        customerId: payment.customerId,
        voucherType: 'PAYMENT_ENTRY',
        voucherId: payment.id,
        invoiceId: invoice?.id,
        debit: payment.amount,
        credit: new Prisma.Decimal(0),
        currency: payment.currency,
        remarks: `${payment.paymentNo} received`,
      },
      {
        postingDate: payment.date,
        accountId: ar.id,
        customerId: payment.customerId,
        voucherType: 'PAYMENT_ENTRY',
        voucherId: payment.id,
        invoiceId: invoice?.id,
        debit: new Prisma.Decimal(0),
        credit: payment.amount,
        currency: payment.currency,
        remarks: `${payment.paymentNo} receivable settlement`,
      },
    ],
  });
}

async function postPaymentEntryLedger(tx: any, entry: any, isReversal = false) {
  const bank = await ensureAccount(tx, '1000', 'Bank / Cash', 'ASSET');
  const ar = await ensureAccount(tx, '1100', 'Accounts Receivable', 'ASSET');
  const factor = isReversal ? -1 : 1;
  await tx.generalLedgerEntry.createMany({
    data: [
      {
        postingDate: entry.date,
        accountId: bank.id,
        customerId: entry.customerId,
        voucherType: isReversal ? 'CANCELLATION' : 'PAYMENT_ENTRY',
        voucherId: entry.id,
        paymentEntryId: entry.id,
        debit: entry.paidAmount.mul(factor),
        credit: new Prisma.Decimal(0),
        currency: entry.currency,
        remarks: `${isReversal ? 'Reverse ' : ''}${entry.paymentNo} bank receipt`,
        isReversal,
      },
      {
        postingDate: entry.date,
        accountId: ar.id,
        customerId: entry.customerId,
        voucherType: isReversal ? 'CANCELLATION' : 'PAYMENT_ENTRY',
        voucherId: entry.id,
        paymentEntryId: entry.id,
        debit: new Prisma.Decimal(0),
        credit: entry.paidAmount.mul(factor),
        currency: entry.currency,
        remarks: `${isReversal ? 'Reverse ' : ''}${entry.paymentNo} receivable settlement`,
        isReversal,
      },
    ],
  });
}

export const getInvoices = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, customerId, search, fromDate, toDate, overdue } = req.query as any;
    const where: any = { ...apiStatusToWhere(status) };
    if (customerId) where.customerId = customerId;
    if (fromDate || toDate) where.date = { ...(fromDate ? { gte: new Date(fromDate) } : {}), ...(toDate ? { lte: new Date(toDate) } : {}) };
    if (overdue === 'true') where.paymentStatus = 'OVERDUE';
    if (search) {
      where.OR = [
        { invoiceNo: { contains: search, mode: 'insensitive' } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.salesInvoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.salesInvoice.count({ where }),
    ]);

    return paginated(res, items.map(invoiceResponse), total, page, limit);
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const getInvoice = async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.salesInvoice.findUnique({ where: { id: req.params.id }, include: invoiceInclude });
    if (!invoice) return error(res, 'Invoice not found', 404);
    return success(res, invoiceResponse(invoice));
  } catch (err: any) {
    if (!err.code && err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const createInvoice = async (req: Request, res: Response) => {
  try {
    const { customerId, salesOrderId, date, dueDate, items = [], notes, terms, currency, discount } = req.body;
    if (!customerId) return error(res, 'customerId is required', 400);
    if (!items.length) return error(res, 'At least one invoice item is required', 400);

    const invoice = await prisma.$transaction(async (tx) => {
      const invoiceNo = await nextDocumentNo(tx, 'SALES_INVOICE');
      const normalizedItems = await normalizeInvoiceItems(tx, items);
      const totals = calculateInvoiceTotals(normalizedItems, discount);
      const created = await tx.salesInvoice.create({
        data: {
          invoiceNo,
          customerId,
          salesOrderId,
          date: date ? new Date(date) : new Date(),
          dueDate: dueDate ? new Date(dueDate) : undefined,
          status: 'DRAFT',
          paymentStatus: 'UNPAID',
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          discount: totals.discount,
          total: totals.grandTotal,
          grandTotal: totals.grandTotal,
          outstandingAmount: totals.grandTotal,
          amountPaid: new Prisma.Decimal(0),
          currency: currency || 'USD',
          notes,
          terms,
          items: { create: totals.lines },
        },
        include: invoiceInclude,
      });
      await audit(tx, req, { entityType: 'SALES_INVOICE', entityId: created.id, invoiceId: created.id, action: 'CREATE', statusAfter: 'DRAFT', message: `Created ${created.invoiceNo}` });
      return created;
    });
    return success(res, invoiceResponse(invoice), 'Invoice created', 201);
  } catch (err: any) {
    if (!err.code && err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const createInvoiceFromSalesOrder = async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({
        where: { id: req.params.salesOrderId },
        include: { items: { include: { product: true } } },
      });
      if (!order) throw new Error('Sales order not found');
      if (order.status === 'DRAFT' || order.status === 'CANCELLED') throw new Error('Only confirmed sales orders can be invoiced');

      const invoiceNo = await nextDocumentNo(tx, 'SALES_INVOICE');
      const sourceItems = order.items.map((item: any) => ({
        productId: item.productId,
        itemCode: item.product?.sku || '',
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate,
        discount: item.discount,
      }));
      const totals = calculateInvoiceTotals(sourceItems, order.discount);
      return tx.salesInvoice.create({
        data: {
          invoiceNo,
          customerId: order.customerId,
          salesOrderId: order.id,
          date: new Date(),
          status: 'DRAFT',
          paymentStatus: 'UNPAID',
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          discount: totals.discount,
          total: totals.grandTotal,
          grandTotal: totals.grandTotal,
          outstandingAmount: totals.grandTotal,
          amountPaid: new Prisma.Decimal(0),
          currency: order.currency,
          notes: order.notes,
          terms: order.terms,
          items: { create: totals.lines },
        },
        include: invoiceInclude,
      });
    });
    return success(res, invoiceResponse(invoice), 'Invoice created from sales order', 201);
  } catch (err: any) {
    if (err.message) return error(res, err.message, 400);
    return handlePrismaError(res, err);
  }
};

export const createInvoiceFromDeliveryNote = async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.$transaction(async (tx) => {
      const note = await tx.deliveryNote.findUnique({
        where: { id: req.params.deliveryNoteId },
        include: { items: { include: { product: true } }, salesOrder: true },
      });
      if (!note) throw new Error('Delivery note not found');
      if (note.status !== 'SUBMITTED') throw new Error('Only submitted delivery notes can be invoiced');
      const invoiceNo = await nextDocumentNo(tx, 'SALES_INVOICE');
      const sourceItems = note.items.map((item: any) => ({
        productId: item.productId,
        itemCode: item.itemCode || item.product?.sku || '',
        description: item.description || item.product?.name,
        quantity: item.quantity,
        unitPrice: item.product?.salePrice || 0,
        taxRate: item.product?.taxRate || 0,
        discount: 0,
        taxTemplateId: item.product?.defaultTaxTemplateId,
      }));
      const totals = calculateInvoiceTotals(sourceItems);
      const created = await tx.salesInvoice.create({
        data: {
          invoiceNo,
          customerId: note.customerId,
          salesOrderId: note.salesOrderId,
          deliveryNoteId: note.id,
          date: new Date(),
          dueDate: note.salesOrder?.deliveryDate,
          status: 'DRAFT',
          paymentStatus: 'UNPAID',
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          discount: totals.discount,
          total: totals.grandTotal,
          grandTotal: totals.grandTotal,
          outstandingAmount: totals.grandTotal,
          amountPaid: new Prisma.Decimal(0),
          currency: note.salesOrder?.currency || 'USD',
          notes: note.notes,
          terms: note.salesOrder?.terms,
          items: { create: totals.lines },
        },
        include: invoiceInclude,
      });
      await audit(tx, req, { entityType: 'SALES_INVOICE', entityId: created.id, invoiceId: created.id, action: 'CREATE_FROM_DELIVERY_NOTE', statusAfter: 'DRAFT', message: `Created ${created.invoiceNo} from ${note.deliveryNo}` });
      return created;
    });
    return success(res, invoiceResponse(invoice), 'Invoice created from delivery note', 201);
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const updateInvoice = async (req: Request, res: Response) => {
  try {
    const { items, discount, date, dueDate, ...data } = req.body;
    const invoice = await prisma.$transaction(async (tx) => {
      const existing = await tx.salesInvoice.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('Invoice not found');
      if (existing.status !== 'DRAFT') throw new Error('Only draft invoices can be edited');

      const normalizedItems = items ? await normalizeInvoiceItems(tx, items) : null;
      const totals = normalizedItems ? calculateInvoiceTotals(normalizedItems, discount) : null;
      if (items) await tx.salesInvoiceItem.deleteMany({ where: { salesInvoiceId: existing.id } });

      const updated = await tx.salesInvoice.update({
        where: { id: existing.id },
        data: {
          ...data,
          ...(date ? { date: new Date(date) } : {}),
          ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
          ...(totals ? {
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            discount: totals.discount,
            total: totals.grandTotal,
            grandTotal: totals.grandTotal,
            outstandingAmount: totals.grandTotal,
            items: { create: totals.lines },
          } : {}),
        },
        include: invoiceInclude,
      });
      await audit(tx, req, { entityType: 'SALES_INVOICE', entityId: updated.id, invoiceId: updated.id, action: 'UPDATE', statusBefore: existing.status, statusAfter: updated.status, message: `Updated ${updated.invoiceNo}` });
      return updated;
    });
    return success(res, invoiceResponse(invoice), 'Invoice updated');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const updateInvoiceStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const invoiceId = await prisma.$transaction(async (tx) => {
      const existing = await tx.salesInvoice.findUnique({
        where: { id: req.params.id },
        include: { items: { include: { product: { select: { id: true, type: true } } } } },
      });
      if (!existing) throw new Error('Invoice not found');
      if (status === 'SUBMITTED' || status === 'SENT') {
        if (existing.status !== 'DRAFT') throw new Error('Only draft invoices can be submitted');
        await tx.salesInvoice.update({
          where: { id: existing.id },
          data: { status: 'SUBMITTED', submittedAt: new Date(), outstandingAmount: existing.grandTotal.minus(existing.amountPaid), paymentStatus: 'UNPAID' },
        });
        await resolveAndSnapshotInvoiceTaxes(tx, existing.id, existing);
        if (!existing.deliveryNoteId) await postStockOut(tx, existing.items, existing.invoiceNo, 'Stock issued from submitted sales invoice');
        await postInvoiceLedger(tx, existing);
        await audit(tx, req, { entityType: 'SALES_INVOICE', entityId: existing.id, invoiceId: existing.id, action: 'SUBMIT', statusBefore: existing.status, statusAfter: 'SUBMITTED', message: `Submitted ${existing.invoiceNo}` });
        return existing.id;
      }
      if (status === 'CANCELLED') {
        if (existing.status === 'DRAFT') throw new Error('Delete draft invoices instead of cancelling');
        if (existing.status === 'CANCELLED') throw new Error('Invoice is already cancelled');
        await postInvoiceLedger(tx, existing, true);
        if (!existing.deliveryNoteId) await postStockOut(tx, existing.items, existing.invoiceNo, 'Stock returned from cancelled sales invoice', undefined, true);
        await tx.salesInvoice.update({
          where: { id: existing.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), paymentStatus: 'UNPAID' },
        });
        await audit(tx, req, { entityType: 'SALES_INVOICE', entityId: existing.id, invoiceId: existing.id, action: 'CANCEL', statusBefore: existing.status, statusAfter: 'CANCELLED', message: `Cancelled ${existing.invoiceNo}` });
        return existing.id;
      }
      throw new Error('Unsupported invoice status transition');
    });
    const invoice = await prisma.salesInvoice.findUnique({ where: { id: invoiceId }, include: invoiceInclude });
    return success(res, invoiceResponse(invoice), 'Invoice status updated');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const deleteInvoice = async (req: Request, res: Response) => {
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.salesInvoice.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('Invoice not found');
      if (existing.status !== 'DRAFT') throw new Error('Submitted invoices cannot be deleted. Cancel the invoice instead.');
      await audit(tx, req, { entityType: 'SALES_INVOICE', entityId: existing.id, invoiceId: existing.id, action: 'DELETE', statusBefore: existing.status, message: `Deleted draft ${existing.invoiceNo}` });
      await tx.salesInvoice.delete({ where: { id: existing.id } });
    });
    return success(res, null, 'Invoice deleted');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const amendInvoice = async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.$transaction(async (tx) => {
      const existing = await tx.salesInvoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
      if (!existing) throw new Error('Invoice not found');
      if (existing.status !== 'CANCELLED') throw new Error('Only cancelled invoices can be amended');
      const invoiceNo = `${existing.invoiceNo}-1`;
      const amended = await tx.salesInvoice.create({
        data: {
          invoiceNo,
          amendedFromId: existing.id,
          customerId: existing.customerId,
          salesOrderId: existing.salesOrderId,
          date: new Date(),
          dueDate: existing.dueDate,
          status: 'DRAFT',
          paymentStatus: 'UNPAID',
          subtotal: existing.subtotal,
          taxAmount: existing.taxAmount,
          discount: existing.discount,
          total: existing.grandTotal,
          grandTotal: existing.grandTotal,
          outstandingAmount: existing.grandTotal,
          amountPaid: new Prisma.Decimal(0),
          currency: existing.currency,
          notes: existing.notes,
          terms: existing.terms,
          items: {
            create: existing.items.map((item: any) => ({
              productId: item.productId,
              itemCode: item.itemCode,
              description: item.description,
              quantity: item.quantity,
              rate: item.rate,
              unitPrice: item.rate,
              discount: item.discount,
              taxRate: item.taxRate,
              netAmount: item.netAmount,
              taxAmount: item.taxAmount,
              total: item.total,
              taxTemplateId: item.taxTemplateId,
            })),
          },
        },
        include: invoiceInclude,
      });
      await audit(tx, req, { entityType: 'SALES_INVOICE', entityId: amended.id, invoiceId: amended.id, action: 'AMEND', statusAfter: 'DRAFT', message: `Amended from ${existing.invoiceNo}` });
      return amended;
    });
    return success(res, invoiceResponse(invoice), 'Invoice amended', 201);
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const getInvoicePdf = async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.salesInvoice.findUnique({ where: { id: req.params.id }, include: invoiceInclude });
    if (!invoice) return error(res, 'Invoice not found', 404);
    const printFormat = await prisma.printFormat.findFirst({
      where: { docType: 'SALES_INVOICE', isActive: true, isDefault: true },
      orderBy: { createdAt: 'asc' },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceNo}.pdf"`);
    return res.send(renderInvoicePdf(invoice, printFormat));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getAgingReport = async (_req: Request, res: Response) => {
  try {
    const invoices = await prisma.salesInvoice.findMany({
      where: { status: 'SUBMITTED', paymentStatus: { not: 'PAID' } },
      include: { customer: { select: { id: true, name: true } } },
    });

    const today = new Date();
    const byCustomer = new Map<string, any>();
    const totals = { current: 0, days0To30: 0, days31To60: 0, days61To90: 0, days90Plus: 0, totalOutstanding: 0 };

    for (const invoice of invoices) {
      const outstanding = serializeMoney(invoice.outstandingAmount);
      if (outstanding <= 0) continue;
      const key = invoice.customerId;
      const row = byCustomer.get(key) || {
        customerId: key,
        customerName: invoice.customer?.name || 'Unknown',
        currency: invoice.currency,
        current: 0,
        days0To30: 0,
        days31To60: 0,
        days61To90: 0,
        days90Plus: 0,
        totalOutstanding: 0,
      };
      const dueDate = invoice.dueDate || invoice.date;
      const days = Math.floor((today.getTime() - dueDate.getTime()) / 86400000);
      const bucket = days <= 0 ? 'current' : days <= 30 ? 'days0To30' : days <= 60 ? 'days31To60' : days <= 90 ? 'days61To90' : 'days90Plus';
      row[bucket] += outstanding;
      row.totalOutstanding += outstanding;
      totals[bucket as keyof typeof totals] += outstanding;
      totals.totalOutstanding += outstanding;
      byCustomer.set(key, row);
    }

    return res.json({ success: true, data: Array.from(byCustomer.values()), totals });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getPayments = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { customerId, invoiceId, method, fromDate, toDate } = req.query as any;
    const where: any = {};
    if (customerId) where.customerId = customerId;
    if (invoiceId) where.invoiceId = invoiceId;
    if (method) where.method = method;
    if (fromDate || toDate) where.date = { ...(fromDate ? { gte: new Date(fromDate) } : {}), ...(toDate ? { lte: new Date(toDate) } : {}) };

    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: { customer: { select: { name: true } }, invoice: { select: { invoiceNo: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payment.count({ where }),
    ]);
    return paginated(res, items.map((payment: any) => ({ ...payment, amount: serializeMoney(payment.amount) })), total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getPayment = async (req: Request, res: Response) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: { customer: { select: { name: true } }, invoice: { select: { invoiceNo: true } } },
    });
    if (!payment) return error(res, 'Payment not found', 404);
    return success(res, { ...payment, amount: serializeMoney(payment.amount) });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

function serializePaymentEntry(entry: any) {
  return {
    ...entry,
    paidAmount: serializeMoney(entry.paidAmount),
    allocatedAmount: serializeMoney(entry.allocatedAmount),
    unallocatedAmount: serializeMoney(entry.unallocatedAmount),
    allocations: entry.allocations?.map((allocation: any) => ({
      ...allocation,
      allocatedAmount: serializeMoney(allocation.allocatedAmount),
    })),
  };
}

export const getPaymentEntries = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { customerId, status } = req.query as any;
    const where: any = {};
    if (customerId) where.customerId = customerId;
    if (status) where.status = status;
    const [items, total] = await Promise.all([
      prisma.paymentEntry.findMany({
        where,
        include: { customer: { select: { name: true } }, allocations: { include: { invoice: { select: { invoiceNo: true, grandTotal: true, outstandingAmount: true } }, creditNote: { select: { creditNoteNo: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.paymentEntry.count({ where }),
    ]);
    return paginated(res, items.map(serializePaymentEntry), total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getPaymentEntry = async (req: Request, res: Response) => {
  try {
    const entry = await prisma.paymentEntry.findUnique({
      where: { id: req.params.id },
      include: { customer: true, allocations: { include: { invoice: { select: { invoiceNo: true, grandTotal: true, outstandingAmount: true } }, creditNote: { select: { creditNoteNo: true } } } }, ledgerEntries: true },
    });
    if (!entry) return error(res, 'Payment entry not found', 404);
    return success(res, serializePaymentEntry(entry));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createPaymentEntry = async (req: Request, res: Response) => {
  try {
    const { type = 'RECEIVED', customerId, date, paidAmount, currency = 'USD', method = 'BANK_TRANSFER', reference, notes, allocations = [] } = req.body;
    if (!customerId) return error(res, 'customerId is required', 400);
    if (!paidAmount || Number(paidAmount) <= 0) return error(res, 'paidAmount must be greater than zero', 400);
    const entry = await prisma.$transaction(async (tx) => {
      const paymentNo = await nextDocumentNo(tx, 'PAYMENT_ENTRY');
      const allocatedAmount = allocations.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.allocatedAmount || 0), new Prisma.Decimal(0));
      const paid = new Prisma.Decimal(paidAmount);
      if (allocatedAmount.gt(paid)) throw new Error('Allocated amount cannot exceed paid amount');
      const created = await tx.paymentEntry.create({
        data: {
          paymentNo,
          type,
          customerId,
          date: date ? new Date(date) : new Date(),
          paidAmount: paid,
          allocatedAmount,
          unallocatedAmount: paid.minus(allocatedAmount),
          currency,
          method,
          reference,
          notes,
          allocations: {
            create: allocations.map((row: any) => ({
              allocationType: row.allocationType || (row.creditNoteId ? 'CREDIT_NOTE' : row.invoiceId ? 'INVOICE' : 'ADVANCE'),
              invoiceId: row.invoiceId,
              creditNoteId: row.creditNoteId,
              allocatedAmount: new Prisma.Decimal(row.allocatedAmount || 0),
            })),
          },
        },
        include: { customer: true, allocations: { include: { invoice: true, creditNote: true } } },
      });
      await audit(tx, req, { entityType: 'PAYMENT_ENTRY', entityId: created.id, action: 'CREATE', statusAfter: 'DRAFT', message: `Created ${created.paymentNo}` });
      return created;
    });
    return success(res, serializePaymentEntry(entry), 'Payment entry created', 201);
  } catch (err: any) {
    if (err.message) return error(res, err.message, 400);
    return handlePrismaError(res, err);
  }
};

export const updatePaymentEntryStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const entry = await prisma.$transaction(async (tx) => {
      const existing = await tx.paymentEntry.findUnique({ where: { id: req.params.id }, include: { allocations: true } });
      if (!existing) throw new Error('Payment entry not found');
      if (status === 'SUBMITTED') {
        if (existing.status !== 'DRAFT') throw new Error('Only draft payment entries can be submitted');
        for (const allocation of existing.allocations) {
          if (allocation.invoiceId) {
            const invoice = await tx.salesInvoice.findUnique({ where: { id: allocation.invoiceId } });
            if (!invoice || invoice.status !== 'SUBMITTED') throw new Error('Payment allocations require submitted invoices');
            if (new Prisma.Decimal(allocation.allocatedAmount).gt(invoice.outstandingAmount)) throw new Error(`Allocation exceeds outstanding for ${invoice.invoiceNo}`);
          }
        }
        const submitted = await tx.paymentEntry.update({ where: { id: existing.id }, data: { status: 'SUBMITTED', submittedAt: new Date() }, include: { allocations: true, customer: true } });
        await postPaymentEntryLedger(tx, submitted);
        for (const allocation of submitted.allocations) {
          if (allocation.invoiceId) await recalculateInvoiceAllocations(tx, allocation.invoiceId);
        }
        await audit(tx, req, { entityType: 'PAYMENT_ENTRY', entityId: submitted.id, action: 'SUBMIT', statusBefore: existing.status, statusAfter: 'SUBMITTED', message: `Submitted ${submitted.paymentNo}` });
        return tx.paymentEntry.findUnique({ where: { id: submitted.id }, include: { customer: true, allocations: { include: { invoice: true, creditNote: true } }, ledgerEntries: true } });
      }
      if (status === 'CANCELLED') {
        if (existing.status !== 'SUBMITTED') throw new Error('Only submitted payment entries can be cancelled');
        const cancelled = await tx.paymentEntry.update({ where: { id: existing.id }, data: { status: 'CANCELLED', cancelledAt: new Date() }, include: { allocations: true, customer: true } });
        await postPaymentEntryLedger(tx, cancelled, true);
        for (const allocation of cancelled.allocations) {
          if (allocation.invoiceId) await recalculateInvoiceAllocations(tx, allocation.invoiceId);
        }
        await audit(tx, req, { entityType: 'PAYMENT_ENTRY', entityId: cancelled.id, action: 'CANCEL', statusBefore: existing.status, statusAfter: 'CANCELLED', message: `Cancelled ${cancelled.paymentNo}` });
        return cancelled;
      }
      throw new Error('Unsupported payment entry transition');
    });
    return success(res, serializePaymentEntry(entry), 'Payment entry updated');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const createPayment = async (req: Request, res: Response) => {
  try {
    const { type = 'RECEIVED', customerId, invoiceId, date, amount, currency, method = 'BANK_TRANSFER', reference, notes } = req.body;
    const payment = await prisma.$transaction(async (tx) => {
      const invoice = invoiceId ? await tx.salesInvoice.findUnique({ where: { id: invoiceId } }) : null;
      if (invoiceId && !invoice) throw new Error('Invoice not found');
      if (invoice && invoice.status !== 'SUBMITTED') throw new Error('Payments can only be recorded against submitted invoices');
      const paymentAmount = new Prisma.Decimal(amount);
      if (invoice && paymentAmount.gt(invoice.outstandingAmount)) throw new Error('Payment cannot exceed outstanding amount');
      const paymentNo = await nextDocumentNo(tx, 'PAYMENT_ENTRY');
      const created = await tx.payment.create({
        data: {
          paymentNo,
          type,
          customerId: customerId || invoice?.customerId,
          invoiceId,
          date: date ? new Date(date) : new Date(),
          amount: paymentAmount,
          currency: currency || invoice?.currency || 'USD',
          method,
          reference,
          notes,
        },
        include: { customer: true, invoice: true },
      });
      if (invoiceId) {
        await recalculateInvoicePayment(tx, invoiceId);
        await postPaymentLedger(tx, created, invoice);
      }
      return created;
    });
    return success(res, { ...payment, amount: serializeMoney(payment.amount) }, 'Payment recorded', 201);
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const deletePayment = async (req: Request, res: Response) => {
  try {
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: req.params.id } });
      if (!payment) throw new Error('Payment not found');
      await tx.payment.delete({ where: { id: payment.id } });
      if (payment.invoiceId) await recalculateInvoicePayment(tx, payment.invoiceId);
    });
    return success(res, null, 'Payment reversed');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};
