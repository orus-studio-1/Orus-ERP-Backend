import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generateInvoiceNo, generatePaymentNo } from '../utils/generate';
import { promiseHooks } from 'node:v8';
import { totalmem } from 'node:os';
import { InvoiceStatus } from '@prisma/client';
import PDFDocument, { readableHighWaterMark } from 'pdfkit';

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

// Get Customer Invoices.
export const getCustomerInvoices = async (req : Request , res : Response)=>{
  try{
    const customerId = req.params.id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const { status, fromDate, toDate } = req.query as any;

    const where : any = { customerId }
    if(status){
      where.status = status;
    }
    if(fromDate || toDate){
      where.date= {};
      if (fromDate) where.date.gte = new Date(fromDate);
      if (toDate) where.date.lte = new Date(toDate);
    }

    const [invoices , total] = await Promise.all([
      prisma.salesInvoice.findMany({
        where,
        orderBy : {date : 'desc'},
        skip : (page - 1) * limit,
        take : limit,
      }),
      prisma.salesInvoice.count({ where }),
    ]);

    const formattedInvoices = invoices.map((inv) => {
      return {
        ...inv,
        outstanding : inv.total - inv.amountPaid,
      };
    });

    const totalPages = Math.ceil(total/limit);

    return res.status(200).json({
      data : formattedInvoices,
      pagination : {
        page,
        limit,
        total,
        totalPages,
      },
    });
  }catch(err : any){
    return handlePrismaError(res,err);
  }
};

// Get Customer Outstanding Summary
export const getCustomerOutstandingSummary = async (req : Request , res : Response) =>{
  try{
    const customerId = req.params.id;

    const customer = await prisma.customer.findUnique({
      where : { id : customerId },
      select : { name : true , currency : true }
    });
    if(!customer){
      return res.status(404).json({success : false , messag : 'Customer Not Found'});
    }

    const invoices = await prisma.salesInvoice.findMany({
      where : {
        customerId : customerId,
        status : {
          notIn : ['DRAFT', 'CANCELLED']
        }
      }
    });

    let totalInvoiced = 0;
    let amountPaid = 0;
    let overdueOutstanding = 0;
    let openInvoiceCount = 0;
    let overdueInvoiceCount = 0;

    const today = new Date();

    invoices.forEach((inv)=>{
      totalInvoiced += inv.total;
      amountPaid += inv.amountPaid;

      const outStandingForThisInvoice = inv.total - inv.amountPaid;
      if(outStandingForThisInvoice > 0){
        openInvoiceCount++;

        if(inv.dueDate && new Date(inv.dueDate) < today){
          overdueInvoiceCount++;
          overdueOutstanding += outStandingForThisInvoice;
        }
      }
    });

    const outstanding = totalInvoiced - amountPaid;

    return res.status(200).json({
      customerId: customerId,
      customerName: customer.name,
      currency: customer.currency || 'USD',
      totalInvoiced: totalInvoiced,
      amountPaid: amountPaid,
      outstanding: outstanding,
      overdueOutstanding: overdueOutstanding,
      openInvoiceCount: openInvoiceCount,
      overdueInvoiceCount: overdueInvoiceCount
    });
  }catch(err : any){
    return handlePrismaError(res , err);
  }
};

// Search Products 
export const searchProducts = async (req : Request , res : Response) => {
  try{
    const query = (req.query.q as string) || '';
    
    if(!query.trim()){
      return res.status(200).json({ data : [] });
    }

    const products = await prisma.product.findMany({
      where : {
        isActive : true,
        OR :[
          { name : { contains: query , mode: 'insensitive' }},
          { sku: { contains: query, mode: 'insensitive' }}
        ]
      },
      select: {
        id: true,
        sku: true,
        name: true,
        salePrice: true,
        taxRate: true,
        unitId: true,
        unit: {
          select: {
            id: true,
            name: true,
            symbol: true
          }
        }
      },
      take: 20
    });
    return res.status(200).json({data : products})
  }catch(err : any){
    return handlePrismaError(res, err);
  }
}
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

// Create Invoice from salesOrder
export const createInvoiceFromSalesOrder = async(req: Request , res: Response)=>{
  try{
    const { salesOrderId } = req.params;
    const salesOrder = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { items: true}
    });

    if(!salesOrder) return error(res, 'Sales Order not found', 404);

    const allowedStatuses = ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
    if (!allowedStatuses.includes(salesOrder.status)) {
      return error(res, `Invoices can only be created from orders that are ${allowedStatuses.join(', ')}`, 400);
    }

    const invoiceNo = await generateInvoiceNo();

    // 4. SERVER-SIDE MATHS RECALCULATION (Strict Security Guard)
    let calculatedSubtotal = 0;
    let calculatedTaxAmount = 0;

    // Loop chalakar Sales Order ke items ko Invoice items ke structure mein copy aur recalculate karenge
    const invoiceItemsData = salesOrder.items.map((item) => {
      const quantity = item.quantity || 0;
      const unitPrice = item.unitPrice || 0;
      const discountPercent = item.discount || 0;
      const taxRate = item.taxRate || 0;

      // Mathematical logic for line item
      const lineBase = quantity * unitPrice;
      const discountAmount = (lineBase * discountPercent) / 100;
      const lineAfterDiscount = lineBase - discountAmount;
      const taxAmount = (lineAfterDiscount * taxRate) / 100;
      const lineTotal = lineAfterDiscount + taxAmount;

      // Main header totals ko jodo
      calculatedSubtotal += lineAfterDiscount;
      calculatedTaxAmount += taxAmount;

      return {
        productId: item.productId,
        description: item.description,
        quantity: quantity,
        unitPrice: unitPrice,
        taxRate: taxRate,
        discount: discountPercent,
        total: lineTotal, // Verified server side total
      };
    });

    // Grand total (Sales order ka global discount bhi yahan adjust kar sakte hain agar bacha ho)
    const calculatedTotal = calculatedSubtotal + calculatedTaxAmount - (salesOrder.discount || 0);

    // 5. Database Transaction chalayenge (Invoice creation + Status Update)
    const finalInvoice = await prisma.$transaction(async (tx) => {
      
      // Step A: Naya Invoice create karo DRAFT status ke sath
      const newInvoice = await tx.salesInvoice.create({
        data: {
          invoiceNo,
          customerId: salesOrder.customerId,
          salesOrderId: salesOrder.id, // Direct linkage setup done!
          date: new Date(), // Invoice billing date aaj ki
          status: 'DRAFT', // Senior Rule: Invoice shuru mein DRAFT hi banega
          subtotal: calculatedSubtotal,
          taxAmount: calculatedTaxAmount,
          discount: salesOrder.discount || 0,
          total: calculatedTotal,
          currency: salesOrder.currency || 'USD',
          notes: salesOrder.notes,
          terms: salesOrder.terms,
          items: {
            create: invoiceItemsData, // Saare child items copy ho gaye
          },
        },
        include: { 
          customer: { select: { name: true } }, 
          items: true 
        },
      });

      await tx.salesOrder.update({
        where: { id: salesOrder.id },
        data: { status: 'PROCESSING' }, 
      });

      return newInvoice;
    });

    // 6. Senior ke doc ke mutabik full invoice details return karo
    return success(res, finalInvoice, 'Invoice created as DRAFT from Sales Order successfully', 201);

  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// Update sales invoice 
export const updateSalesInvoice = async (req: Request , res: Response) =>{
  try{
    const { id } = req.params;
    const { items, date, dueDate, notes, terms, currency, discount } = req.body;

    const existingInvoice = await prisma.salesInvoice.findUnique({
      where: { id },
    });

    if(!existingInvoice) return error(res, 'Invoice not found', 404);
    if(existingInvoice.status !== 'DRAFT') return error(res, 'Only draft invoices can be updated', 404);

    let calculatedSubtotal = 0;
    let calculatedTaxAmount = 0;

    // Loop chalakar har item ka line total aur tax calculate karenge
    const newItemsData = items.map((item: any) => {
      const quantity = item.quantity || 0;
      const unitPrice = item.unitPrice || 0;
      const discountPercent = item.discount || 0; // Line item discount percentage
      const taxRate = item.taxRate || 0;

      // Basic Line Mathematics
      const lineBase = quantity * unitPrice;
      const discountAmount = (lineBase * discountPercent) / 100;
      const lineAfterDiscount = lineBase - discountAmount;
      const taxAmount = (lineAfterDiscount * taxRate) / 100;
      const lineTotal = lineAfterDiscount + taxAmount;

      // Cumulative Invoice Totals
      calculatedSubtotal += lineAfterDiscount;
      calculatedTaxAmount += taxAmount;

      return {
        productId: item.productId,
        description: item.description,
        quantity: quantity,
        unitPrice: unitPrice,
        taxRate: taxRate,
        discount: discountPercent,
        total: lineTotal, // Backend computed line total
      };
    });

    // Grand Total calculation (Subtract global discount if any)
    const calculatedTotal = calculatedSubtotal + calculatedTaxAmount - (discount || 0);

    // 4. Prisma Transaction use karenge (Purane items clear karke naye items create karenge)
    const updatedInvoice = await prisma.$transaction(async (tx) => {
      
      // Step A: Purane saare invoice line items ko uda do
      await tx.salesInvoiceItem.deleteMany({
        where: { salesInvoiceId: id },
      });

      // Step B: Main Invoice table ko update karo (Notice: we are NOT touching amountPaid field)
      const invoice = await tx.salesInvoice.update({
        where: { id },
        data: {
          date: date ? new Date(date) : undefined,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          subtotal: calculatedSubtotal,
          taxAmount: calculatedTaxAmount,
          discount: discount || 0,
          total: calculatedTotal,
          currency: currency || 'USD',
          notes,
          terms,
          items: {
            create: newItemsData, // Naye calculated items ko link kiya
          },
        },
        include: {
          items: true // Taki responsive array response clean dikhe
        }
      });

      return invoice;
    });
    return success(res,updatedInvoice,'Invoice Updates Successfully');
  }catch(err : any){
    return handlePrismaError(res, err);
  }
}

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

// Get Single Payment 
export const getPayment = async (req: Request, res: Response)=>{
  try{
    const { id } = req.params;
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        customer: true,
        invoice: true,
      },
    });
    if(!payment) return error(res,'Payment Record not found',404);
    return success(res,payment);
  }catch(err: any){
    return handlePrismaError(res, err);
  }
}


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

export const getAgingReport = async (req: Request, res: Response)=>{
  try{
    const today = new Date();
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        status: {
          notIn: ['DRAFT', 'PAID', 'CANCELLED'],
        },
      },
      include: {
        customer: {
          select: { id: true, name: true, currency: true},
        }
      },
    });

    const customerMap : Record<string , any> = {};
    const globalTotals = {
      current: 0,
      days0To30: 0,
      days31To60: 0,
      days61To90: 0,
      days90Plus: 0,
      totalOutstanding: 0,
    };
    invoices.forEach((inv) => {
      const outstanding = inv.total - inv.amountPaid;

      // Agar bill poori tarah outstanding hai tabhi check chalega
      if (outstanding <= 0) return;

      const custId = inv.customerId;
      const custName = inv.customer?.name || 'Unknown';
      const custCurrency = inv.customer?.currency || 'USD';

      // Agar map mein yeh customer pehle nahi aaya toh uska bucket structure banao
      if (!customerMap[custId]) {
        customerMap[custId] = {
          customerId: custId,
          customerName: custName,
          currency: custCurrency,
          current: 0,
          days0To30: 0,
          days31To60: 0,
          days61To90: 0,
          days90Plus: 0,
          totalOutstanding: 0,
        };
      }

      // Date difference mathematically in days
      const dueDate = inv.dueDate ? new Date(inv.dueDate) : today;
      const diffTime = today.getTime() - dueDate.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // 3. Bucket Classification (Due Date Rules matching)
      if (dueDate >= today) {
        // Due date abhi tak aayi nahi hai ya aaj hi hai
        customerMap[custId].current += outstanding;
        globalTotals.current += outstanding;
      } else if (diffDays > 0 && diffDays <= 30) {
        customerMap[custId].days0To30 += outstanding;
        globalTotals.days0To30 += outstanding;
      } else if (diffDays >= 31 && diffDays <= 60) {
        customerMap[custId].days31To60 += outstanding;
        globalTotals.days31To60 += outstanding;
      } else if (diffDays >= 61 && diffDays <= 90) {
        customerMap[custId].days61To90 += outstanding;
        globalTotals.days61To90 += outstanding;
      } else if (diffDays > 90) {
        customerMap[custId].days90Plus += outstanding;
        globalTotals.days90Plus += outstanding;
      }

      // Customer individual total increment
      customerMap[custId].totalOutstanding += outstanding;
      // Grand global total increment
      globalTotals.totalOutstanding += outstanding;
    });

    const reportData = Object.values(customerMap);
    return res.status(200).json({
      data: reportData,
      totals: globalTotals
    });
  }catch(err: any){
    return handlePrismaError(res, err);
  }
}