import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { generateOrderNo, generateQuotationNo } from '../../utils/generate';
import { normalizeSalesItems } from './shared';

export const getQuotations = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, customerId, search } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (search) where.quotationNo = { contains: search, mode: 'insensitive' };

    const [items, total] = await Promise.all([
      prisma.quotation.findMany({
        where,
        include: { customer: { select: { name: true, email: true } }, items: { include: { product: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.quotation.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getQuotation = async (req: Request, res: Response) => {
  try {
    const q = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { customer: true, items: { include: { product: true } } },
    });
    if (!q) return error(res, 'Quotation not found', 404);
    return success(res, q);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createQuotation = async (req: Request, res: Response) => {
  try {
    const { customerId, date, validUntil, items = [], notes, terms, currency, discount } = req.body;
    if (!customerId) return error(res, 'customerId is required', 400);
    if (!items.length) return error(res, 'At least one quotation item is required', 400);

    const quotation = await prisma.$transaction(async (tx) => {
      const quotationNo = await generateQuotationNo();
      const calculated = await normalizeSalesItems(tx, items, { customerId, currency: currency || 'USD', priceListId: req.body.priceListId });
      const discountAmount = new Prisma.Decimal(discount || 0);
      const total = calculated.subtotal.plus(calculated.taxAmount).minus(discountAmount);
      return tx.quotation.create({
        data: {
          quotationNo,
          customerId,
          date: date ? new Date(date) : new Date(),
          validUntil: validUntil ? new Date(validUntil) : undefined,
          subtotal: calculated.subtotal,
          taxAmount: calculated.taxAmount,
          total,
          discount: discountAmount,
          currency: currency || 'USD',
          notes,
          terms,
          items: { create: calculated.items },
        },
        include: { customer: true, items: { include: { product: true } } },
      });
    });
    return success(res, quotation, 'Quotation created', 201);
  } catch (err: any) {
    if (!err.code && err.message) return error(res, err.message, 400);
    return handlePrismaError(res, err);
  }
};

export const updateQuotation = async (req: Request, res: Response) => {
  try {
    const { items, ...data } = req.body;
    const q = await prisma.quotation.update({
      where: { id: req.params.id },
      data,
      include: { customer: true, items: { include: { product: true } } },
    });
    return success(res, q, 'Quotation updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateQuotationStatus = async (req : Request , res : Response)=>{
  try{
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'];
    if(!validStatuses.includes(status)){
      return error(res , 'Invalid Quotation Status Value' , 400);  
    }

    const quotation = await prisma.quotation.update({
      where: { id },
      data: { status },
      include: { customer: { select: { name: true } } }
    });
    return success(res , quotation , 'Quotation Status Updated Successfully');
  }catch(err : any){
    return handlePrismaError(res , err);
  }
};

export const deleteQuotation = async (req: Request, res: Response) => {
  try {
    await prisma.quotation.delete({ where: { id: req.params.id } });
    return success(res, null, 'Quotation deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const convertQuotationToOrder = async (req: Request, res: Response) => {
  try {
    const q = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!q) return error(res, 'Quotation not found', 404);

    const orderNo = await generateOrderNo();
    const order = await prisma.salesOrder.create({
      data: {
        orderNo, customerId: q.customerId, quotationId: q.id,
        date: new Date(), subtotal: q.subtotal, taxAmount: q.taxAmount,
        total: q.total, discount: q.discount, currency: q.currency,
        notes: q.notes, terms: q.terms,
        items: {
          create: q.items.map(i => ({
            productId: i.productId, description: i.description,
            quantity: i.quantity, unitPrice: i.unitPrice,
            taxRate: i.taxRate, discount: i.discount, total: i.total,
          })),
        },
      },
      include: { customer: true, items: { include: { product: true } } },
    });

    await prisma.quotation.update({ where: { id: q.id }, data: { status: 'ACCEPTED' } });
    return success(res, order, 'Quotation converted to sales order');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
