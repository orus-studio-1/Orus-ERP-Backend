import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { postStockLedger } from '../inventory/stockLedger.service';
import { ensureLedgerAccount, postToLedger, reverseLedgerForVoucher } from '../accounting/ledger.service';

const D = Prisma.Decimal;

export function lineAmount(row: any) {
  const qty = new D(row.quantity || row.receivedQty || 0);
  const rate = new D(row.rate ?? row.unitPrice ?? 0);
  const discount = new D(row.discount || 0);
  const net = qty.mul(rate).mul(new D(1).minus(discount.div(100)));
  const tax = net.mul(new D(row.taxRate || 0)).div(100);
  return { net, tax, total: net.plus(tax) };
}

export function documentTotals(items: any[] = [], discount: any = 0, shippingAmount: any = 0, exchangeRate: any = 1) {
  const subtotal = items.reduce((sum, row) => sum.plus(lineAmount(row).net), new D(0));
  const taxAmount = items.reduce((sum, row) => sum.plus(lineAmount(row).tax), new D(0));
  const shipping = new D(shippingAmount || 0);
  const total = subtotal.plus(taxAmount).plus(shipping).minus(discount || 0);
  return { subtotal, taxAmount, shippingAmount: shipping, total, baseTotal: total.mul(exchangeRate || 1) };
}

export async function nextNo(model: string, field: string, prefix: string, tx: any = prisma) {
  const count = await tx[model].count();
  return `${prefix}-${String(count + 1).padStart(6, '0')}`;
}

export function normalizeItems(items: any[] = []) {
  return items.filter((item) => item.productId && Number(item.quantity || item.receivedQty || 0) > 0);
}

export async function buyingSettings() {
  return (prisma as any).buyingSettings.findFirst() || (prisma as any).buyingSettings.create({ data: {} });
}

export async function createPurchaseReceiptFromOrder(orderId: string, body: any = {}) {
  return prisma.$transaction(async (tx: any) => {
    const order = await tx.purchaseOrder.findUnique({ where: { id: orderId }, include: { supplier: true, items: { include: { product: true } } } });
    if (!order) throw new Error('Purchase order not found');
    const receiptNo = await nextNo('purchaseReceipt', 'receiptNo', 'PREC', tx);
    const items = order.items.map((item: any) => ({
      purchaseOrderItemId: item.id,
      productId: item.productId,
      warehouseId: body.warehouseId || item.product.defaultWarehouseId,
      description: item.description,
      receivedQty: new D(item.quantity).minus(item.receivedQty || 0),
      acceptedQty: new D(item.quantity).minus(item.receivedQty || 0),
      rejectedQty: 0,
      rate: item.unitPrice,
      valuationRate: item.unitPrice,
      uom: item.uom,
      stockUom: item.stockUom,
      conversionFactor: item.conversionFactor || 1,
    })).filter((item: any) => new D(item.receivedQty).gt(0));
    if (!items.length) throw new Error('All purchase order items are already received');
    const totals = documentTotals(items.map((item: any) => ({ quantity: item.acceptedQty, rate: item.rate })), 0, 0, order.exchangeRate || 1);
    return tx.purchaseReceipt.create({
      data: {
        receiptNo,
        supplierId: order.supplierId,
        purchaseOrderId: order.id,
        postingDate: body.postingDate ? new Date(body.postingDate) : new Date(),
        currency: order.currency,
        exchangeRate: order.exchangeRate || 1,
        acceptedQty: items.reduce((sum: any, item: any) => sum.plus(item.acceptedQty), new D(0)),
        rejectedQty: 0,
        subtotal: totals.subtotal,
        costCenterId: order.costCenterId,
        projectId: order.projectId,
        notes: body.notes,
        items: { create: items },
      },
      include: purchaseReceiptInclude,
    });
  });
}

export async function submitPurchaseReceipt(receiptId: string) {
  return prisma.$transaction(async (tx: any) => {
    const receipt = await tx.purchaseReceipt.findUnique({ where: { id: receiptId }, include: { items: true, purchaseOrder: { include: { items: true } } } });
    if (!receipt) throw new Error('Purchase receipt not found');
    if (receipt.status !== 'DRAFT') throw new Error('Only draft purchase receipts can be submitted');
    for (const item of receipt.items) {
      const accepted = new D(item.acceptedQty || item.receivedQty || 0).mul(item.conversionFactor || 1);
      if (accepted.gt(0)) {
        await postStockLedger(tx, {
          productId: item.productId,
          warehouseId: item.warehouseId,
          actualQty: accepted,
          rate: new D(item.valuationRate || item.rate || 0),
          voucherType: 'PURCHASE_RECEIPT',
          voucherId: receipt.id,
          voucherNo: receipt.receiptNo,
          postingDate: receipt.postingDate,
          remarks: `Purchase receipt ${receipt.receiptNo}`,
        });
      }
      if (item.purchaseOrderItemId) {
        await tx.purchaseOrderItem.update({ where: { id: item.purchaseOrderItemId }, data: { receivedQty: { increment: Number(accepted.toString()) } } });
      }
    }
    await refreshPurchaseOrderProgress(tx, receipt.purchaseOrderId);
    return tx.purchaseReceipt.update({ where: { id: receiptId }, data: { status: 'SUBMITTED', submittedAt: new Date() }, include: purchaseReceiptInclude });
  });
}

export async function submitPurchaseInvoice(invoiceId: string) {
  return prisma.$transaction(async (tx: any) => {
    const existing = await tx.purchaseInvoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
    if (!existing) throw new Error('Purchase invoice not found');
    if (existing.workflowStatus === 'SUBMITTED' || existing.status === 'SENT') return existing;
    const expense = await ensureLedgerAccount(tx, '5100', 'Purchase Expense / Inventory Received', 'EXPENSE');
    const ap = await ensureLedgerAccount(tx, '2000', 'Accounts Payable', 'LIABILITY', { isDefaultPayable: true });
    const tax = await ensureLedgerAccount(tx, '1300', 'Input Tax Receivable', 'ASSET', { isDefaultTax: true });
    const lines: any[] = [{ accountId: expense.id, debit: existing.subtotal || 0, credit: 0, partyType: 'SUPPLIER', partyId: existing.supplierId, costCenterId: existing.costCenterId, remarks: `${existing.invoiceNo} purchase` }];
    if (Number(existing.taxAmount || 0) > 0) lines.push({ accountId: tax.id, debit: existing.taxAmount, credit: 0, partyType: 'SUPPLIER', partyId: existing.supplierId, costCenterId: existing.costCenterId, taxType: 'INPUT', remarks: `${existing.invoiceNo} input tax` });
    lines.push({ accountId: ap.id, debit: 0, credit: existing.total || 0, partyType: 'SUPPLIER', partyId: existing.supplierId, costCenterId: existing.costCenterId, remarks: `${existing.invoiceNo} payable` });
    await postToLedger(tx, { voucherType: 'PURCHASE_INVOICE', voucherId: existing.id, voucherNo: existing.invoiceNo, postingDate: existing.date, lines });
    await refreshPurchaseOrderProgress(tx, existing.purchaseOrderId);
    return tx.purchaseInvoice.update({ where: { id: invoiceId }, data: { workflowStatus: 'SUBMITTED', status: 'SENT', submittedAt: new Date(), outstandingAmount: existing.total || 0 } });
  });
}

export async function refreshPurchaseOrderProgress(tx: any, purchaseOrderId?: string | null) {
  if (!purchaseOrderId) return;
  const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { items: true, invoices: true } });
  if (!po) return;
  const ordered = po.items.reduce((sum: any, item: any) => sum.plus(item.quantity || 0), new D(0));
  const received = po.items.reduce((sum: any, item: any) => sum.plus(item.receivedQty || 0), new D(0));
  const billed = po.invoices.reduce((sum: any, inv: any) => sum.plus(inv.total || 0), new D(0));
  const total = new D(po.total || 0);
  const receivedPercent = ordered.gt(0) ? received.div(ordered).mul(100) : 0;
  const billedPercent = total.gt(0) ? billed.div(total).mul(100) : 0;
  await tx.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      receivedPercent,
      billedPercent,
      status: new D(receivedPercent).gte(100) ? 'RECEIVED' : new D(receivedPercent).gt(0) ? 'RECEIVING' : po.status,
    },
  });
}

export async function postSupplierPayment(paymentId: string) {
  return prisma.$transaction(async (tx: any) => {
    const payment = await tx.supplierPayment.findUnique({ where: { id: paymentId }, include: { purchaseInvoice: true, purchaseOrder: true } });
    if (!payment) throw new Error('Supplier payment not found');
    if (payment.status !== 'DRAFT') throw new Error('Only draft supplier payments can be submitted');
    const bank = await ensureLedgerAccount(tx, '1000', 'Cash / Bank', 'ASSET');
    const ap = await ensureLedgerAccount(tx, '2000', 'Accounts Payable', 'LIABILITY', { isDefaultPayable: true });
    await postToLedger(tx, {
      voucherType: 'SUPPLIER_PAYMENT',
      voucherId: payment.id,
      voucherNo: payment.paymentNo,
      postingDate: payment.date,
      lines: [
        { accountId: ap.id, debit: payment.amount, credit: 0, partyType: 'SUPPLIER', partyId: payment.supplierId, remarks: payment.type === 'ADVANCE' ? 'Supplier advance' : 'Supplier invoice payment' },
        { accountId: bank.id, debit: 0, credit: payment.amount, partyType: 'SUPPLIER', partyId: payment.supplierId, remarks: payment.reference },
      ],
    });
    if (payment.purchaseInvoiceId) {
      const paid = new D(payment.purchaseInvoice.amountPaid || 0).plus(payment.amount);
      const outstanding = D.max(new D(payment.purchaseInvoice.total || 0).minus(paid), new D(0));
      await tx.purchaseInvoice.update({ where: { id: payment.purchaseInvoiceId }, data: { amountPaid: Number(paid.toString()), outstandingAmount: outstanding, status: outstanding.eq(0) ? 'PAID' : 'PARTIAL' } });
    }
    if (payment.purchaseOrderId && payment.type === 'ADVANCE') {
      await tx.purchaseOrder.update({ where: { id: payment.purchaseOrderId }, data: { advancePaid: { increment: payment.amount } } });
    }
    return tx.supplierPayment.update({ where: { id: payment.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), allocatedAmount: payment.purchaseInvoiceId || payment.purchaseOrderId ? payment.amount : 0, unallocatedAmount: payment.purchaseInvoiceId || payment.purchaseOrderId ? 0 : payment.amount } });
  });
}

export async function cancelVoucher(model: string, id: string, voucherType?: any) {
  return prisma.$transaction(async (tx: any) => {
    const doc = await tx[model].findUnique({ where: { id } });
    if (!doc) throw new Error('Document not found');
    if (voucherType) await reverseLedgerForVoucher(tx, voucherType, id, new Date());
    return tx[model].update({ where: { id }, data: { status: 'CANCELLED', workflowStatus: model === 'purchaseInvoice' ? 'CANCELLED' : undefined, cancelledAt: new Date() } });
  });
}

export const poInclude = { supplier: true, items: { include: { product: true } }, invoices: true, receipts: true, payments: true };
export const purchaseReceiptInclude = { supplier: true, purchaseOrder: true, items: { include: { product: true, warehouse: true } }, qualityInspections: true, landedCostVouchers: true };
export const purchaseInvoiceInclude = { supplier: true, purchaseOrder: true, purchaseReceipt: true, items: { include: { product: true } }, payments: true };
