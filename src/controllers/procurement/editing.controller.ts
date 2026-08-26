import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { success, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import {
  blanketOrderItems, documentTotals, materialRequestItems, purchaseInvoiceItems, purchaseOrderItems,
  purchaseReceiptItems, rfqItems, supplierQuotationItems,
} from '../../services/procurement/procurement.service';

const D = Prisma.Decimal;
const draft = (row: any) => !row.status || row.status === 'DRAFT' || row.workflowStatus === 'DRAFT';
const requireDraft = (row: any, label: string) => { if (!row) throw new Error(`${label} not found`); if (!draft(row)) throw new Error(`${label} can only be edited while Draft; use amend or revision after submission`); };

export async function updateProcurementRecord(req: Request, res: Response) {
  try {
    const resource = req.params.resource;
    const id = req.params.id;
    const body = req.body || {};
    const result = await prisma.$transaction(async (tx: any) => {
      if (resource === 'payment-terms') {
        const row = await tx.paymentTermsTemplate.findUnique({ where: { id } });
        if (!row) throw new Error('Payment terms template not found');
        const terms = (body.terms || []).filter((x: any) => x.label && Number(x.percentage) > 0).map((x: any, i: number) => ({ label: x.label, percentage: x.percentage, dueAfterDays: Number(x.dueAfterDays || 0), rowOrder: Number(x.rowOrder ?? i) }));
        if (!terms.length) throw new Error('At least one payment term is required');
        return tx.paymentTermsTemplate.update({ where: { id }, data: { name: body.name, description: body.description, isActive: body.isActive ?? row.isActive, terms: { deleteMany: {}, create: terms } }, include: { terms: true } });
      }
      if (resource === 'supplier-items') {
        const row = await tx.supplierItem.findUnique({ where: { id } });
        if (!row) throw new Error('Supplier item not found');
        return tx.supplierItem.update({ where: { id }, data: { supplierId: body.supplierId, productId: body.productId, supplierItemCode: body.supplierItemCode, supplierItemName: body.supplierItemName, supplierUom: body.supplierUom, conversionFactor: body.conversionFactor, lastPurchaseRate: body.lastPurchaseRate, leadTimeDays: body.leadTimeDays, minimumOrderQty: body.minimumOrderQty, isPreferred: body.isPreferred, isActive: body.isActive } });
      }
      if (resource === 'communications') {
        const row = await tx.supplierCommunication.findUnique({ where: { id } });
        if (!row) throw new Error('Supplier communication not found');
        return tx.supplierCommunication.update({ where: { id }, data: { subject: body.subject, message: body.message, contactPerson: body.contactPerson, direction: body.direction, channel: body.channel } });
      }
      if (resource === 'material-requests') {
        const row = await tx.materialRequest.findUnique({ where: { id } }); requireDraft(row, 'Material request');
        const items = materialRequestItems(body.items); if (!items.length) throw new Error('At least one item is required');
        return tx.materialRequest.update({ where: { id }, data: { type: body.type, requiredBy: body.requiredBy ? new Date(body.requiredBy) : null, costCenterId: body.costCenterId || null, projectId: body.projectId || null, notes: body.notes, items: { deleteMany: {}, create: items } }, include: { items: true } });
      }
      if (resource === 'rfqs') {
        const row = await tx.requestForQuotation.findUnique({ where: { id } }); requireDraft(row, 'RFQ');
        const items = rfqItems(body.items); if (!items.length) throw new Error('At least one item is required');
        return tx.requestForQuotation.update({ where: { id }, data: { validUntil: body.validUntil ? new Date(body.validUntil) : null, terms: body.terms, message: body.message, items: { deleteMany: {}, create: items }, suppliers: body.supplierIds ? { deleteMany: {}, create: body.supplierIds.map((supplierId: string) => ({ supplierId })) } : undefined }, include: { items: true, suppliers: true } });
      }
      if (resource === 'supplier-quotations') {
        const row = await tx.supplierQuotation.findUnique({ where: { id } }); requireDraft(row, 'Supplier quotation');
        const items = supplierQuotationItems(body.items); const totals = documentTotals(items, body.discount, body.shippingAmount, body.exchangeRate || 1);
        return tx.supplierQuotation.update({ where: { id }, data: { supplierId: body.supplierId, rfqId: body.rfqId || null, date: body.date ? new Date(body.date) : undefined, validUntil: body.validUntil ? new Date(body.validUntil) : null, currency: body.currency, exchangeRate: body.exchangeRate, terms: body.terms, notes: body.notes, subtotal: totals.subtotal, taxAmount: totals.taxAmount, shippingAmount: totals.shippingAmount, discount: body.discount || 0, total: totals.total, items: { deleteMany: {}, create: items } }, include: { items: true } });
      }
      if (resource === 'blanket-purchase-orders') {
        const row = await tx.blanketPurchaseOrder.findUnique({ where: { id } }); requireDraft(row, 'Blanket purchase order');
        const items = blanketOrderItems(body.items);
        return tx.blanketPurchaseOrder.update({ where: { id }, data: { supplierId: body.supplierId, startDate: body.startDate ? new Date(body.startDate) : undefined, endDate: body.endDate ? new Date(body.endDate) : undefined, currency: body.currency, terms: body.terms, notes: body.notes, items: { deleteMany: {}, create: items } }, include: { items: true } });
      }
      if (resource === 'purchase-orders') {
        const row = await tx.purchaseOrder.findUnique({ where: { id } }); requireDraft(row, 'Purchase order');
        const items = purchaseOrderItems(body.items); const totals = documentTotals(items, body.discount, body.shippingAmount, body.exchangeRate || 1);
        return tx.purchaseOrder.update({ where: { id }, data: { supplierId: body.supplierId, date: body.date ? new Date(body.date) : undefined, expectedDate: body.expectedDate ? new Date(body.expectedDate) : null, currency: body.currency, exchangeRate: body.exchangeRate, notes: body.notes, terms: body.terms, subtotal: Number(totals.subtotal), taxAmount: Number(totals.taxAmount), shippingAmount: Number(totals.shippingAmount), discount: Number(body.discount || 0), total: Number(totals.total), baseTotal: totals.baseTotal, items: { deleteMany: {}, create: items } }, include: { items: true } });
      }
      if (resource === 'purchase-receipts') {
        const row = await tx.purchaseReceipt.findUnique({ where: { id } }); requireDraft(row, 'Purchase receipt');
        const items = purchaseReceiptItems(body.items);
        return tx.purchaseReceipt.update({ where: { id }, data: { supplierId: body.supplierId, purchaseOrderId: body.purchaseOrderId || null, postingDate: body.postingDate ? new Date(body.postingDate) : undefined, notes: body.notes, acceptedQty: items.reduce((s, x) => s.plus(x.acceptedQty || 0), new D(0)), rejectedQty: items.reduce((s, x) => s.plus(x.rejectedQty || 0), new D(0)), items: { deleteMany: {}, create: items } }, include: { items: true } });
      }
      if (resource === 'quality-inspections') {
        const row = await tx.qualityInspection.findUnique({ where: { id } }); if (!row) throw new Error('Quality inspection not found'); if (row.status !== 'PENDING') throw new Error('Only pending inspections can be edited');
        return tx.qualityInspection.update({ where: { id }, data: { purchaseReceiptId: body.purchaseReceiptId || null, productId: body.productId || null, inspectedQty: body.inspectedQty, acceptedQty: body.acceptedQty || 0, rejectedQty: body.rejectedQty || 0, remarks: body.remarks } });
      }
      if (resource === 'landed-cost-vouchers') {
        const row = await tx.landedCostVoucher.findUnique({ where: { id } }); requireDraft(row, 'Landed cost voucher');
        const charges = (body.charges || []).filter((x: any) => Number(x.amount) > 0); const total = charges.reduce((s: Prisma.Decimal, x: any) => s.plus(x.amount), new D(0));
        return tx.landedCostVoucher.update({ where: { id }, data: { purchaseReceiptId: body.purchaseReceiptId, allocationBasis: body.allocationBasis, postingDate: body.postingDate ? new Date(body.postingDate) : undefined, notes: body.notes, totalCharges: total, charges: { deleteMany: {}, create: charges } }, include: { charges: true } });
      }
      if (resource === 'purchase-invoices') {
        const row = await tx.purchaseInvoice.findUnique({ where: { id } }); requireDraft(row, 'Purchase invoice');
        const items = purchaseInvoiceItems(body.items); const totals = documentTotals(items, body.discount, body.shippingAmount, body.exchangeRate || 1);
        return tx.purchaseInvoice.update({ where: { id }, data: { supplierId: body.supplierId, supplierInvoiceNo: body.supplierInvoiceNo, purchaseOrderId: body.purchaseOrderId || null, purchaseReceiptId: body.purchaseReceiptId || null, date: body.date ? new Date(body.date) : undefined, dueDate: body.dueDate ? new Date(body.dueDate) : null, currency: body.currency, exchangeRate: body.exchangeRate, notes: body.notes, subtotal: Number(totals.subtotal), taxAmount: Number(totals.taxAmount), shippingAmount: Number(totals.shippingAmount), discount: Number(body.discount || 0), total: Number(totals.total), baseTotal: totals.baseTotal, outstandingAmount: totals.total, matchId: null, matchStatus: 'NOT_RUN', postingBlocked: false, items: { deleteMany: {}, create: items } }, include: { items: true } });
      }
      if (resource === 'supplier-payments') {
        const row = await tx.supplierPayment.findUnique({ where: { id } }); requireDraft(row, 'Supplier payment');
        return tx.supplierPayment.update({ where: { id }, data: { supplierId: body.supplierId, purchaseOrderId: body.purchaseOrderId || null, purchaseInvoiceId: body.purchaseInvoiceId || null, type: body.type, date: body.date ? new Date(body.date) : undefined, amount: body.amount, mode: body.mode, reference: body.reference, notes: body.notes, allocatedAmount: 0, unallocatedAmount: body.amount } });
      }
      throw new Error('Unsupported procurement resource');
    });
    return success(res, result, 'Record updated successfully');
  } catch (err: any) {
    if (/only be edited|Only pending/.test(err.message || '')) return error(res, err.message, 409);
    if (err.message) return error(res, err.message, 400);
    return handlePrismaError(res, err);
  }
}
