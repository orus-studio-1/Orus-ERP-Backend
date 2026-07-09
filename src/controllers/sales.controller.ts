import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generateOrderNo, generateQuotationNo } from '../utils/generate';

// ---- QUOTATIONS ----
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
    const { customerId, date, validUntil, items, notes, terms, currency, discount } = req.body;
    const quotationNo = await generateQuotationNo();

    const subtotal = items.reduce((s: number, i: any) => s + i.total, 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.total * (i.taxRate || 0) / 100), 0);
    const total = subtotal + taxAmount - (discount || 0);

    const quotation = await prisma.quotation.create({
      data: {
        quotationNo, customerId, date: new Date(date),
        validUntil: validUntil ? new Date(validUntil) : undefined,
        subtotal, taxAmount, total, discount: discount || 0, currency: currency || 'USD', notes, terms,
        items: { create: items },
      },
      include: { customer: true, items: { include: { product: true } } },
    });
    return success(res, quotation, 'Quotation created', 201);
  } catch (err: any) {
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

// ---- SALES ORDERS ----
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
    const { customerId, date, deliveryDate, items, notes, terms, currency, discount } = req.body;
    const orderNo = await generateOrderNo();

    const subtotal = items.reduce((s: number, i: any) => s + i.total, 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.total * (i.taxRate || 0) / 100), 0);
    const total = subtotal + taxAmount - (discount || 0);

    const order = await prisma.salesOrder.create({
      data: {
        orderNo, customerId, date: new Date(date),
        deliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
        subtotal, taxAmount, total, discount: discount || 0, currency: currency || 'USD', notes, terms,
        items: { create: items },
      },
      include: { customer: true, items: { include: { product: true } } },
    });
    return success(res, order, 'Sales order created', 201);
  } catch (err: any) {
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

