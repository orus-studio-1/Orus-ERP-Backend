import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getWarehouses = async (req: Request, res: Response) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      include: { _count: { select: { stockLevels: true } } },
      orderBy: { name: 'asc' },
    });
    return success(res, warehouses);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createWarehouse = async (req: Request, res: Response) => {
  try {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!name || !code) return error(res, 'Warehouse name and code are required.', 400);
    const wh = await prisma.warehouse.create({ data: { ...req.body, name, code } });
    return success(res, wh, 'Warehouse created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateWarehouse = async (req: Request, res: Response) => {
  try {
    const wh = await prisma.warehouse.update({ where: { id: req.params.id }, data: req.body });
    return success(res, wh, 'Warehouse updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteWarehouse = async (req: Request, res: Response) => {
  try {
    await prisma.warehouse.delete({ where: { id: req.params.id } });
    return success(res, null, 'Warehouse deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
