import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { apiStatusToWhere, invoiceInclude, invoiceResponse } from './shared';

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
