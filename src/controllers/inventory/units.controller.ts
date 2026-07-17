import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getUnits = async (req: Request, res: Response) => {
  try {
    const units = await prisma.unit.findMany({ orderBy: { name: 'asc' } });
    return success(res, units);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createUnit = async (req: Request, res: Response) => {
  try {
    const unit = await prisma.unit.create({ data: req.body });
    return success(res, unit, 'Unit created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteUnit = async (req: Request, res: Response) => {
  try {
    await prisma.unit.delete({ where: { id: req.params.id } });
    return success(res, null, 'Unit deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
