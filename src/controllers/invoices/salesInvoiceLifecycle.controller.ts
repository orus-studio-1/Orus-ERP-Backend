import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { success, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { audit, postStockOut, resolveAndSnapshotInvoiceTaxes } from '../../utils/erp';
import { invoiceInclude, invoiceResponse, postInvoiceLedger } from './shared';

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
