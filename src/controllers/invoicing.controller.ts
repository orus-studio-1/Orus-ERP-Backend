import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generateInvoiceNo, generatePaymentNo } from '../utils/generate';

// ---- SALES INVOICES ----
export const getSalesInvoices = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, customerId, search } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (search) where.OR = [
      { invoiceNo: { contains: search, mode: 'insensitive' } },
      { customer: { name: { contains: search, mode: 'insensitive' } } },
    ];

    const [items, total] = await Promise.all([
      prisma.salesInvoice.findMany({
        where,
        include: { customer: { select: { name: true, email: true } }, items: { include: { product: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.salesInvoice.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getSalesInvoice = async (req: Request, res: Response) => {
  try {
    const inv = await prisma.salesInvoice.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        salesOrder: true,
        items: { include: { product: true } },
        payments: true,
      },
    });
    if (!inv) return error(res, 'Invoice not found', 404);
    return success(res, inv);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createSalesInvoice = async (req: Request, res: Response) => {
  try {
    const { customerId, salesOrderId, date, dueDate, items, notes, terms, currency, discount } = req.body;
    const invoiceNo = await generateInvoiceNo();

    const subtotal = items.reduce((s: number, i: any) => s + i.total, 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.total * (i.taxRate || 0) / 100), 0);
    const total = subtotal + taxAmount - (discount || 0);

    const invoice = await prisma.salesInvoice.create({
      data: {
        invoiceNo, customerId, salesOrderId,
        date: new Date(date),
        dueDate: dueDate ? new Date(dueDate) : undefined,
        subtotal, taxAmount, total, discount: discount || 0, currency: currency || 'USD', notes, terms,
        items: { create: items },
      },
      include: { customer: true, items: { include: { product: true } } },
    });
    return success(res, invoice, 'Invoice created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateInvoiceStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const invoice = await prisma.salesInvoice.update({ where: { id: req.params.id }, data: { status } });
    return success(res, invoice, 'Invoice status updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteSalesInvoice = async (req: Request, res: Response) => {
  try {
    const inv = await prisma.salesInvoice.findUnique({ where: { id: req.params.id } });
    if (!inv) return error(res, 'Invoice not found', 404);
    if (inv.status !== 'DRAFT') return error(res, 'Only draft invoices can be deleted', 400);
    await prisma.salesInvoice.delete({ where: { id: req.params.id } });
    return success(res, null, 'Invoice deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- PAYMENTS ----
export const getPayments = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { type, customerId } = req.query as any;
    const where: any = {};
    if (type) where.type = type;
    if (customerId) where.customerId = customerId;

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
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createPayment = async (req: Request, res: Response) => {
  try {
    const { invoiceId, customerId, amount, method, date, reference, notes, type } = req.body;
    const paymentNo = await generatePaymentNo();

    const payment = await prisma.payment.create({
      data: { paymentNo, invoiceId, customerId, amount, method, date: new Date(date), reference, notes, type: type || 'RECEIVED' },
      include: { customer: true, invoice: true },
    });

    if (invoiceId) {
      const invoice = await prisma.salesInvoice.findUnique({ where: { id: invoiceId } });
      if (invoice) {
        const newAmountPaid = invoice.amountPaid + amount;
        const newStatus = newAmountPaid >= invoice.total ? 'PAID' : 'PARTIAL';
        await prisma.salesInvoice.update({
          where: { id: invoiceId },
          data: { amountPaid: newAmountPaid, status: newStatus },
        });
      }
    }

    return success(res, payment, 'Payment recorded', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deletePayment = async (req: Request, res: Response) => {
  try {
    await prisma.payment.delete({ where: { id: req.params.id } });
    return success(res, null, 'Payment deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

