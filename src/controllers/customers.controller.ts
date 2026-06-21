import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generateCustomerNo } from '../utils/generate';

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

    const [items, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: { _count: { select: { salesOrders: true, invoices: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
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
    return success(res, customer);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const customerNo = await generateCustomerNo();
    const customer = await prisma.customer.create({ data: { ...req.body, customerNo } });
    return success(res, customer, 'Customer created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.update({ where: { id: req.params.id }, data: req.body });
    return success(res, customer, 'Customer updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteCustomer = async (req: Request, res: Response) => {
  try {
    await prisma.customer.delete({ where: { id: req.params.id } });
    return success(res, null, 'Customer deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

