import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { generateOrderNo } from '../../utils/generate';
import { normalizeSalesItems } from './shared';

export const getSalesOrders = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, customerId, search } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (search) where.orderNo = { contains: search, mode: 'insensitive' };

    const [items, total] = await Promise.all([
      prisma.salesOrder.findMany({
        where,
        include: { customer: { select: { name: true, email: true } }, items: { include: { product: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.salesOrder.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getSalesOrder = async (req: Request, res: Response) => {
  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: req.params.id },
      include: { customer: true, quotation: true, items: { include: { product: true } }, invoices: true },
    });
    if (!order) return error(res, 'Sales order not found', 404);
    return success(res, order);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createSalesOrder = async (req: Request, res: Response) => {
  try {
    const { customerId, date, deliveryDate, items = [], notes, terms, currency, discount } = req.body;
    if (!customerId) return error(res, 'customerId is required', 400);
    if (!items.length) return error(res, 'At least one sales order item is required', 400);

    const order = await prisma.$transaction(async (tx) => {
      const orderNo = await generateOrderNo();
      const calculated = await normalizeSalesItems(tx, items);
      const discountAmount = new Prisma.Decimal(discount || 0);
      const total = calculated.subtotal.plus(calculated.taxAmount).minus(discountAmount);
      return tx.salesOrder.create({
        data: {
          orderNo,
          customerId,
          date: date ? new Date(date) : new Date(),
          deliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
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
    return success(res, order, 'Sales order created', 201);
  } catch (err: any) {
    if (!err.code && err.message) return error(res, err.message, 400);
    return handlePrismaError(res, err);
  }
};

//Update Sales Order
export const updateSalesOrder = async (req : Request , res: Response)=>{
  try{
    const { id } = req.params;
    const { items, notes, terms, currency, discount, deliveryDate } = req.body;

    const existingOrder = await prisma.salesOrder.findUnique({
      where: { id },
    });
    
    if(!existingOrder) return error(res, 'Sales Order not found' , 404);
    if(existingOrder.status !== 'DRAFT'){
      return error(res,'Only draft sales orders can be updates' , 400);
    }
    
    let calculatedSubtotal = 0;
    let calculatedTaxAmount = 0;

    const newItemsData = items.map((item : any) =>{
      const quantity = item.quantity || 0;
      const unitPrice = item.unitPrice || 0;
      const discountPercent = item.discount || 0; // Item level discount percent
      const taxRate = item.taxRate || 0;

      // Basic calculation
      const lineBase = quantity * unitPrice;
      const discountAmount = (lineBase * discountPercent) / 100;
      const lineAfterDiscount = lineBase - discountAmount;
      const taxAmount = (lineAfterDiscount * taxRate) / 100;
      const lineTotal = lineAfterDiscount + taxAmount;

      calculatedSubtotal += lineAfterDiscount;
      calculatedTaxAmount += taxAmount;

      return {
        productId: item.productId,
        description: item.description,
        quantity: quantity,
        unitPrice: unitPrice,
        taxRate: taxRate,
        discount: discountPercent,
        total: lineTotal, // Server verified total
      };
    });
    const calculatedTotal = calculatedSubtotal + calculatedTaxAmount - (discount || 0);
    const updatedOrder = await prisma.$transaction(async (tx) =>{
      await tx.salesOrderItem.deleteMany({
        where: { salesOrderId: id },
      });

      const order = await tx.salesOrder.update({
        where: { id },
        data: {
          deliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
          subtotal: calculatedSubtotal,
          taxAmount: calculatedTaxAmount,
          discount: discount || 0,
          total: calculatedTotal,
          currency: currency || 'USD',
          notes,
          terms,
          // Naye items ko cascade create command bhej rahe hain
          items: {
            create: newItemsData,
          },
        },
        include: { items: true },
      });

      return order;
    });

    return success(res, updatedOrder, 'Sales Order Updates Successfully');
  }catch(err : any){
    return handlePrismaError(res , err);
  }
}

export const updateSalesOrderStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const order = await prisma.salesOrder.update({
      where: { id: req.params.id },
      data: { status },
    });
    return success(res, order, 'Order status updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteSalesOrder = async (req: Request, res: Response) => {
  try {
    const order = await prisma.salesOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return error(res, 'Order not found', 404);
    if (order.status !== 'DRAFT') return error(res, 'Only draft orders can be deleted', 400);
    await prisma.salesOrder.delete({ where: { id: req.params.id } });
    return success(res, null, 'Sales order deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
