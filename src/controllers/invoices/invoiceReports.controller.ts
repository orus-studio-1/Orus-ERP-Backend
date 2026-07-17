import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { serializeMoney } from '../../utils/invoice';
import { renderInvoicePdf } from '../../utils/pdf';
import { invoiceInclude } from './shared';

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
