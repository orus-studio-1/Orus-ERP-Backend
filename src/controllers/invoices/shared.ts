import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { calculateInvoiceTotals, serializeInvoice, serializeMoney } from '../../utils/invoice';
import { recalculateInvoiceAllocations } from '../../utils/erp';

export async function nextDocumentNo(tx: any, documentType: 'SALES_INVOICE' | 'PAYMENT_ENTRY' | 'CREDIT_NOTE') {
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

export function apiStatusToWhere(status?: string) {
  if (!status) return {};
  if (status === 'DRAFT' || status === 'CANCELLED') return { status };
  if (status === 'SENT') return { status: 'SUBMITTED', paymentStatus: 'UNPAID' };
  return { status: 'SUBMITTED', paymentStatus: status };
}

export function invoiceResponse(invoice: any) {
  const serialized = serializeInvoice(invoice);
  if (serialized.status === 'SUBMITTED') {
    serialized.status = serialized.paymentStatus === 'UNPAID' ? 'SENT' : serialized.paymentStatus;
  }
  return serialized;
}

export async function normalizeInvoiceItems(tx: any, items: any[]) {
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

export async function recalculateInvoicePayment(tx: any, invoiceId: string) {
  await recalculateInvoiceAllocations(tx, invoiceId);
  return tx.salesInvoice.findUnique({ where: { id: invoiceId }, include: invoiceInclude });
}

export const invoiceInclude = {
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

export async function postInvoiceLedger(tx: any, invoice: any, isReversal = false) {
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

export async function postPaymentLedger(tx: any, payment: any, invoice: any) {
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

export async function postPaymentEntryLedger(tx: any, entry: any, isReversal = false) {
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

export function serializePaymentEntry(entry: any) {
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
