import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { calculateInvoiceTotals, serializeInvoice } from '../../utils/invoice';
import { addMonths, resolveAndSnapshotInvoiceTaxes } from '../../utils/erp';
import { nextNo } from './shared';

const D = Prisma.Decimal;

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
