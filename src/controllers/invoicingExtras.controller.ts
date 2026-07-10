import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { calculateInvoiceTotals, serializeInvoice, serializeMoney } from '../utils/invoice';
import { addMonths, audit, ensureAccount, recalculateInvoiceAllocations, resolveAndSnapshotInvoiceTaxes } from '../utils/erp';

const D = Prisma.Decimal;

async function nextNo(tx: any, documentType: 'CREDIT_NOTE' | 'SALES_INVOICE') {
  const prefix = documentType === 'CREDIT_NOTE' ? 'CN' : 'INV';
  let series = await tx.numberingSeries.findFirst({ where: { documentType, isDefault: true, isActive: true } });
  if (!series) {
    series = await tx.numberingSeries.create({
      data: { documentType, name: `${prefix}-DEFAULT`, pattern: `${prefix}-${new Date().getFullYear()}-#####`, prefix, digits: 5, isDefault: true },
    });
  }
  const updated = await tx.numberingSeries.update({ where: { id: series.id }, data: { current: { increment: 1 } } });
  return updated.pattern.replace('#'.repeat(updated.digits), String(updated.current).padStart(updated.digits, '0'));
}

function serializeCreditNote(note: any) {
  return {
    ...note,
    subtotal: serializeMoney(note.subtotal),
    taxAmount: serializeMoney(note.taxAmount),
    grandTotal: serializeMoney(note.grandTotal),
    items: note.items?.map((item: any) => ({
      ...item,
      quantity: serializeMoney(item.quantity),
      rate: serializeMoney(item.rate),
      discount: serializeMoney(item.discount),
      netAmount: serializeMoney(item.netAmount),
      taxAmount: serializeMoney(item.taxAmount),
      total: serializeMoney(item.total),
    })),
  };
}

async function postCreditNoteLedger(tx: any, note: any, isReversal = false) {
  const ar = await ensureAccount(tx, '1100', 'Accounts Receivable', 'ASSET');
  const salesReturns = await ensureAccount(tx, '4010', 'Sales Returns / Credits', 'REVENUE');
  const tax = await ensureAccount(tx, '2100', 'Tax Payable', 'LIABILITY');
  const factor = isReversal ? -1 : 1;
  const rows: any[] = [
    {
      accountId: salesReturns.id,
      customerId: note.customerId,
      voucherType: isReversal ? 'CANCELLATION' : 'CREDIT_NOTE',
      voucherId: note.id,
      creditNoteId: note.id,
      debit: note.subtotal.mul(factor),
      credit: new D(0),
      currency: note.currency,
      remarks: `${isReversal ? 'Reverse ' : ''}${note.creditNoteNo} sales credit`,
      isReversal,
    },
    {
      accountId: ar.id,
      customerId: note.customerId,
      voucherType: isReversal ? 'CANCELLATION' : 'CREDIT_NOTE',
      voucherId: note.id,
      creditNoteId: note.id,
      debit: new D(0),
      credit: note.grandTotal.mul(factor),
      currency: note.currency,
      remarks: `${isReversal ? 'Reverse ' : ''}${note.creditNoteNo} receivable reduction`,
      isReversal,
    },
  ];
  if (note.taxAmount.gt(0)) {
    rows.push({
      accountId: tax.id,
      customerId: note.customerId,
      voucherType: isReversal ? 'CANCELLATION' : 'CREDIT_NOTE',
      voucherId: note.id,
      creditNoteId: note.id,
      debit: note.taxAmount.mul(factor),
      credit: new D(0),
      currency: note.currency,
      remarks: `${isReversal ? 'Reverse ' : ''}${note.creditNoteNo} tax credit`,
      isReversal,
    });
  }
  await tx.generalLedgerEntry.createMany({ data: rows });
}

export const getTaxTemplates = async (_req: Request, res: Response) => {
  try {
    const templates = await prisma.taxTemplate.findMany({ include: { lines: { orderBy: { rowOrder: 'asc' } } }, orderBy: { name: 'asc' } });
    return success(res, templates.map((template: any) => ({
      ...template,
      lines: template.lines.map((line: any) => ({ ...line, rate: serializeMoney(line.rate) })),
    })));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createTaxTemplate = async (req: Request, res: Response) => {
  try {
    const { lines = [], ...data } = req.body;
    const template = await prisma.taxTemplate.create({
      data: {
        ...data,
        lines: {
          create: lines.map((line: any, index: number) => ({
            label: line.label,
            rate: new D(line.rate || 0),
            chargeType: line.chargeType || 'ON_NET_TOTAL',
            rowOrder: line.rowOrder ?? index,
            accountId: line.accountId,
            isRecoverable: !!line.isRecoverable,
          })),
        },
      },
      include: { lines: true },
    });
    return success(res, template, 'Tax template created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateTaxTemplate = async (req: Request, res: Response) => {
  try {
    const { lines, ...data } = req.body;
    const template = await prisma.$transaction(async (tx) => {
      if (lines) await tx.taxTemplateLine.deleteMany({ where: { taxTemplateId: req.params.id } });
      return tx.taxTemplate.update({
        where: { id: req.params.id },
        data: {
          ...data,
          ...(lines ? { lines: { create: lines.map((line: any, index: number) => ({ label: line.label, rate: new D(line.rate || 0), chargeType: line.chargeType || 'ON_NET_TOTAL', rowOrder: line.rowOrder ?? index, accountId: line.accountId })) } } : {}),
        },
        include: { lines: true },
      });
    });
    return success(res, template, 'Tax template updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getCreditNotes = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const [items, total] = await Promise.all([
      prisma.creditNote.findMany({
        include: { customer: { select: { name: true } }, originalInvoice: { select: { invoiceNo: true } }, items: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.creditNote.count(),
    ]);
    return paginated(res, items.map(serializeCreditNote), total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getCreditNote = async (req: Request, res: Response) => {
  try {
    const note = await prisma.creditNote.findUnique({
      where: { id: req.params.id },
      include: { customer: true, originalInvoice: true, items: { include: { product: true } }, ledgerEntries: true },
    });
    if (!note) return error(res, 'Credit note not found', 404);
    return success(res, serializeCreditNote(note));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createCreditNote = async (req: Request, res: Response) => {
  try {
    const { originalInvoiceId, reason = 'OTHER', notes, items } = req.body;
    const note = await prisma.$transaction(async (tx) => {
      const invoice = await tx.salesInvoice.findUnique({ where: { id: originalInvoiceId }, include: { items: { include: { product: true } } } });
      if (!invoice) throw new Error('Invoice not found');
      if (invoice.status !== 'SUBMITTED') throw new Error('Credit notes can only be created for submitted invoices');
      const creditNoteNo = await nextNo(tx, 'CREDIT_NOTE');
      const sourceItems = (items?.length ? items : invoice.items).map((item: any) => ({
        productId: item.productId,
        itemCode: item.itemCode || item.product?.sku || '',
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.rate || item.unitPrice,
        taxRate: item.taxRate || 0,
        discount: item.discount || 0,
      }));
      const totals = calculateInvoiceTotals(sourceItems);
      const created = await tx.creditNote.create({
        data: {
          creditNoteNo,
          customerId: invoice.customerId,
          originalInvoiceId: invoice.id,
          reason,
          currency: invoice.currency,
          notes,
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          grandTotal: totals.grandTotal,
          items: {
            create: totals.lines.map((line) => ({
              productId: line.productId,
              itemCode: line.itemCode,
              description: line.description,
              quantity: line.quantity,
              rate: line.rate,
              discount: line.discount,
              netAmount: line.netAmount,
              taxAmount: line.taxAmount,
              total: line.total,
            })),
          },
        },
        include: { customer: true, originalInvoice: true, items: true },
      });
      await audit(tx, req, { entityType: 'CREDIT_NOTE', entityId: created.id, creditNoteId: created.id, action: 'CREATE', statusAfter: 'DRAFT', message: `Created ${created.creditNoteNo}` });
      return created;
    });
    return success(res, serializeCreditNote(note), 'Credit note created', 201);
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const updateCreditNoteStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const note = await prisma.$transaction(async (tx) => {
      const existing = await tx.creditNote.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('Credit note not found');
      if (status === 'SUBMITTED') {
        if (existing.status !== 'DRAFT') throw new Error('Only draft credit notes can be submitted');
        const invoice = await tx.salesInvoice.findUnique({ where: { id: existing.originalInvoiceId } });
        if (invoice) {
          await tx.paymentEntryAllocation.create({
            data: {
              paymentEntryId: (await tx.paymentEntry.create({
                data: {
                  paymentNo: `ADV-${existing.creditNoteNo}`,
                  status: 'SUBMITTED',
                  type: 'RECEIVED',
                  customerId: existing.customerId,
                  paidAmount: existing.grandTotal,
                  allocatedAmount: existing.grandTotal,
                  unallocatedAmount: new D(0),
                  currency: existing.currency,
                  method: 'ONLINE',
                  reference: existing.creditNoteNo,
                },
              })).id,
              allocationType: 'CREDIT_NOTE',
              invoiceId: invoice.id,
              creditNoteId: existing.id,
              allocatedAmount: existing.grandTotal,
            },
          });
          await recalculateInvoiceAllocations(tx, invoice.id);
        }
        const submitted = await tx.creditNote.update({ where: { id: existing.id }, data: { status: 'SUBMITTED', submittedAt: new Date() }, include: { customer: true, originalInvoice: true, items: true } });
        await postCreditNoteLedger(tx, submitted);
        await audit(tx, req, { entityType: 'CREDIT_NOTE', entityId: submitted.id, creditNoteId: submitted.id, action: 'SUBMIT', statusBefore: existing.status, statusAfter: 'SUBMITTED', message: `Submitted ${submitted.creditNoteNo}` });
        return submitted;
      }
      if (status === 'CANCELLED') {
        if (existing.status !== 'SUBMITTED') throw new Error('Only submitted credit notes can be cancelled');
        await postCreditNoteLedger(tx, existing, true);
        await tx.paymentEntryAllocation.deleteMany({ where: { creditNoteId: existing.id } });
        await recalculateInvoiceAllocations(tx, existing.originalInvoiceId);
        const cancelled = await tx.creditNote.update({ where: { id: existing.id }, data: { status: 'CANCELLED', cancelledAt: new Date() }, include: { customer: true, originalInvoice: true, items: true } });
        await audit(tx, req, { entityType: 'CREDIT_NOTE', entityId: cancelled.id, creditNoteId: cancelled.id, action: 'CANCEL', statusBefore: existing.status, statusAfter: 'CANCELLED', message: `Cancelled ${cancelled.creditNoteNo}` });
        return cancelled;
      }
      throw new Error('Unsupported credit note transition');
    });
    return success(res, serializeCreditNote(note), 'Credit note updated');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const getLedgerEntries = async (req: Request, res: Response) => {
  try {
    const { invoiceId, paymentEntryId, creditNoteId, accountId } = req.query as any;
    const entries = await prisma.generalLedgerEntry.findMany({
      where: { invoiceId, paymentEntryId, creditNoteId, accountId },
      include: { account: { select: { code: true, name: true, type: true } } },
      orderBy: { postingDate: 'desc' },
    });
    return success(res, entries.map((entry: any) => ({ ...entry, debit: serializeMoney(entry.debit), credit: serializeMoney(entry.credit) })));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getPrintFormats = async (_req: Request, res: Response) => {
  try {
    const formats = await prisma.printFormat.findMany({ orderBy: { name: 'asc' } });
    return success(res, formats);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createPrintFormat = async (req: Request, res: Response) => {
  try {
    const format = await prisma.printFormat.create({
      data: {
        name: req.body.name,
        docType: req.body.docType || 'SALES_INVOICE',
        isDefault: !!req.body.isDefault,
        template: req.body.template || { sections: ['header', 'customer', 'items', 'taxes', 'totals', 'terms'] },
        letterhead: req.body.letterhead,
        footer: req.body.footer,
      },
    });
    return success(res, format, 'Print format created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getSubscriptions = async (_req: Request, res: Response) => {
  try {
    const subscriptions = await prisma.subscriptionTemplate.findMany({ include: { customer: { select: { name: true } }, items: true }, orderBy: { nextRunDate: 'asc' } });
    return success(res, subscriptions);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createSubscription = async (req: Request, res: Response) => {
  try {
    const { items = [], ...data } = req.body;
    const subscription = await prisma.subscriptionTemplate.create({
      data: {
        ...data,
        startDate: new Date(data.startDate),
        endDate: data.endDate ? new Date(data.endDate) : undefined,
        nextRunDate: new Date(data.nextRunDate || data.startDate),
        items: {
          create: items.map((item: any) => ({
            productId: item.productId,
            itemCode: item.itemCode || '',
            description: item.description,
            quantity: new D(item.quantity || 1),
            rate: new D(item.rate || item.unitPrice || 0),
            discount: new D(item.discount || 0),
            taxTemplateId: item.taxTemplateId,
          })),
        },
      },
      include: { items: true },
    });
    return success(res, subscription, 'Subscription created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const runDueSubscriptions = async (_req: Request, res: Response) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const due = await tx.subscriptionTemplate.findMany({
        where: {
          isActive: true,
          nextRunDate: { lte: new Date() },
          OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
        },
        include: { items: { include: { product: true } } },
      });

      const generated = [];
      for (const subscription of due) {
        const invoiceNo = await nextNo(tx, 'SALES_INVOICE');
        const sourceItems = subscription.items.map((item: any) => ({
          productId: item.productId,
          itemCode: item.itemCode || item.product?.sku || '',
          description: item.description || item.product?.name,
          quantity: item.quantity,
          unitPrice: item.rate,
          discount: item.discount,
          taxRate: item.product?.taxRate || 0,
          taxTemplateId: item.taxTemplateId,
        }));
        const totals = calculateInvoiceTotals(sourceItems);
        const invoice = await tx.salesInvoice.create({
          data: {
            invoiceNo,
            customerId: subscription.customerId,
            date: subscription.nextRunDate,
            dueDate: addMonths(subscription.nextRunDate, 'MONTHLY'),
            status: subscription.autoSubmit ? 'SUBMITTED' : 'DRAFT',
            submittedAt: subscription.autoSubmit ? new Date() : undefined,
            paymentStatus: 'UNPAID',
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            discount: totals.discount,
            total: totals.grandTotal,
            grandTotal: totals.grandTotal,
            outstandingAmount: totals.grandTotal,
            amountPaid: new D(0),
            currency: subscription.currency,
            notes: subscription.notes,
            terms: subscription.terms,
            items: { create: totals.lines },
            subscriptionRuns: { create: { subscriptionTemplateId: subscription.id, runDate: subscription.nextRunDate } },
          },
        });
        if (subscription.autoSubmit) await resolveAndSnapshotInvoiceTaxes(tx, invoice.id);
        const nextRunDate = addMonths(subscription.nextRunDate, subscription.frequency);
        await tx.subscriptionTemplate.update({
          where: { id: subscription.id },
          data: {
            nextRunDate,
            isActive: subscription.endDate ? nextRunDate <= subscription.endDate : subscription.isActive,
          },
        });
        generated.push(invoice);
      }
      return generated;
    });
    return success(res, result.map(serializeInvoice), `Generated ${result.length} recurring invoices`);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export async function runDueSubscriptionsJob() {
  await prisma.$transaction(async (tx) => {
    const due = await tx.subscriptionTemplate.findMany({
      where: { isActive: true, nextRunDate: { lte: new Date() }, OR: [{ endDate: null }, { endDate: { gte: new Date() } }] },
      include: { items: { include: { product: true } } },
    });
    for (const subscription of due) {
      const invoiceNo = await nextNo(tx, 'SALES_INVOICE');
      const totals = calculateInvoiceTotals(subscription.items.map((item: any) => ({
        productId: item.productId,
        itemCode: item.itemCode || item.product?.sku || '',
        description: item.description || item.product?.name,
        quantity: item.quantity,
        unitPrice: item.rate,
        discount: item.discount,
        taxRate: item.product?.taxRate || 0,
        taxTemplateId: item.taxTemplateId,
      })));
      await tx.salesInvoice.create({
        data: {
          invoiceNo,
          customerId: subscription.customerId,
          date: subscription.nextRunDate,
          dueDate: addMonths(subscription.nextRunDate, 'MONTHLY'),
          status: subscription.autoSubmit ? 'SUBMITTED' : 'DRAFT',
          submittedAt: subscription.autoSubmit ? new Date() : undefined,
          paymentStatus: 'UNPAID',
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          discount: totals.discount,
          total: totals.grandTotal,
          grandTotal: totals.grandTotal,
          outstandingAmount: totals.grandTotal,
          amountPaid: new D(0),
          currency: subscription.currency,
          notes: subscription.notes,
          terms: subscription.terms,
          items: { create: totals.lines },
          subscriptionRuns: { create: { subscriptionTemplateId: subscription.id, runDate: subscription.nextRunDate } },
        },
      });
      const nextRunDate = addMonths(subscription.nextRunDate, subscription.frequency);
      await tx.subscriptionTemplate.update({ where: { id: subscription.id }, data: { nextRunDate, isActive: subscription.endDate ? nextRunDate <= subscription.endDate : subscription.isActive } });
    }
  });
}

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
