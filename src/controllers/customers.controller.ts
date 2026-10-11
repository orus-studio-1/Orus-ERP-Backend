import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generateCustomerNo } from '../utils/generate';
import { serializeInvoice, serializeMoney } from '../utils/invoice';
import { pickDefined } from '../utils/payload';
import { computeCustomerPriority, emptyPriority, tierRank } from '../services/crm/customerPriority.service';

const customerFields = ['name', 'email', 'phone', 'contactId', 'address', 'city', 'state', 'country', 'zip', 'taxId', 'currency', 'creditLimit', 'paymentTerms', 'notes', 'isActive'] as const;

export const getCustomers = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { search, isActive } = req.query as any;
    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { customerNo: { contains: search, mode: 'insensitive' } },
    ];

    // Tier, won deals and billing come from computeCustomerPriority. Sorting or filtering by them needs
    // every customer's figures, so that path ranks in memory and then pages the result.
    const { sort, tier, source, overdue } = req.query as any;
    const priority = await computeCustomerPriority();
    const withPriority = (items: any[]) => items.map((item) => ({ ...item, priority: priority.get(item.id) || emptyPriority() }));
    const include = { _count: { select: { salesOrders: true, invoices: true } } };

    if (sort === 'priority' || tier || source || overdue === 'true') {
      const candidates = await prisma.customer.findMany({ where, select: { id: true, createdAt: true } });
      const wantedTier = String(tier || '').toUpperCase();
      const matching = candidates
        .filter((row) => {
          const entry = priority.get(row.id) || emptyPriority();
          if (wantedTier && (wantedTier === 'NONE' ? entry.tier !== null : entry.tier !== wantedTier)) return false;
          if (source && (source === 'DIRECT' ? entry.source !== null : entry.source !== source)) return false;
          if (overdue === 'true' && entry.overdueInvoices === 0) return false;
          return true;
        })
        .sort((x, y) => {
          const a1 = priority.get(x.id) || emptyPriority();
          const b1 = priority.get(y.id) || emptyPriority();
          return tierRank(a1.tier) - tierRank(b1.tier) || b1.score - a1.score || y.createdAt.getTime() - x.createdAt.getTime();
        });
      const ids = matching.slice((page - 1) * limit, page * limit).map((row) => row.id);
      const rows = await prisma.customer.findMany({ where: { id: { in: ids } }, include });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return paginated(res, withPriority(ids.map((id) => byId.get(id)).filter(Boolean) as any[]), matching.length, page, limit);
    }

    const [items, total] = await Promise.all([
      prisma.customer.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.customer.count({ where }),
    ]);
    return paginated(res, withPriority(items), total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getCustomer = async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        salesOrders: { take: 5, orderBy: { createdAt: 'desc' } },
        invoices: { take: 5, orderBy: { createdAt: 'desc' } },
        payments: { take: 5, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!customer) return error(res, 'Customer not found', 404);
    // Where the customer came from and the deals that were won, for the "customer story" card.
    const priority = (await computeCustomerPriority()).get(customer.id) || emptyPriority();
    const [lead, wonDeals] = await Promise.all([
      priority.leadId ? prisma.lead.findFirst({ where: { id: priority.leadId }, select: { id: true, title: true, source: true, createdAt: true } }) : null,
      prisma.opportunity.findMany({ where: { customerId: customer.id, stage: 'CLOSED_WON' }, orderBy: { wonAt: 'desc' }, take: 100, select: { id: true, title: true, value: true, currency: true, wonAt: true, contact: { select: { id: true, firstName: true, lastName: true } } } }),
    ]);
    return success(res, { ...customer, priority, story: { lead, wonDeals } });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const customerNo = await generateCustomerNo();
    const customer = await prisma.customer.create({ data: { ...pickDefined(req.body, customerFields), customerNo } as any });
    return success(res, customer, 'Customer created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.update({ where: { id: req.params.id }, data: pickDefined(req.body, customerFields) as any });
    return success(res, customer, 'Customer updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteCustomer = async (req: Request, res: Response) => {
  try {
    await prisma.customer.update({ where: { id: req.params.id }, data: { isActive: false } });
    return success(res, null, 'Customer deactivated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getCustomerInvoices = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, fromDate, toDate } = req.query as any;
    const where: any = { customerId: req.params.id };
    if (status) {
      if (status === 'DRAFT' || status === 'CANCELLED') where.status = status;
      else {
        where.status = 'SUBMITTED';
        where.paymentStatus = status === 'SENT' ? 'UNPAID' : status;
      }
    }
    if (fromDate || toDate) where.date = { ...(fromDate ? { gte: new Date(fromDate) } : {}), ...(toDate ? { lte: new Date(toDate) } : {}) };

    const [items, total] = await Promise.all([
      prisma.salesInvoice.findMany({
        where,
        include: { customer: { select: { id: true, name: true, email: true } }, items: true, payments: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.salesInvoice.count({ where }),
    ]);
    return paginated(res, items.map((invoice: any) => {
      const serialized = serializeInvoice(invoice);
      if (serialized.status === 'SUBMITTED') serialized.status = serialized.paymentStatus === 'UNPAID' ? 'SENT' : serialized.paymentStatus;
      return serialized;
    }), total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getCustomerOutstanding = async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return error(res, 'Customer not found', 404);
    const invoices = await prisma.salesInvoice.findMany({
      where: { customerId: req.params.id, status: { not: 'CANCELLED' } },
    });
    const totalInvoiced = invoices.filter(i => i.status !== 'DRAFT').reduce((sum, invoice) => sum + serializeMoney(invoice.grandTotal), 0);
    const amountPaid = invoices.reduce((sum, invoice) => sum + serializeMoney(invoice.amountPaid), 0);
    const outstanding = invoices.filter(i => i.status !== 'DRAFT').reduce((sum, invoice) => sum + serializeMoney(invoice.outstandingAmount), 0);
    const overdueInvoices = invoices.filter(i => i.paymentStatus === 'OVERDUE');
    const overdueOutstanding = overdueInvoices.reduce((sum, invoice) => sum + serializeMoney(invoice.outstandingAmount), 0);
    return success(res, {
      customerId: customer.id,
      customerName: customer.name,
      currency: customer.currency,
      totalInvoiced,
      amountPaid,
      outstanding,
      overdueOutstanding,
      openInvoiceCount: invoices.filter(i => i.status !== 'DRAFT' && i.status !== 'CANCELLED' && serializeMoney(i.outstandingAmount) > 0).length,
      overdueInvoiceCount: overdueInvoices.length,
    });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
