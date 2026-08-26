import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { pickDefined } from '../../utils/payload';

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
    if (!String(req.body.name || '').trim() || !String(req.body.symbol || '').trim()) return error(res, 'Unit name and symbol are required', 400);
    const unit = await prisma.unit.create({ data: pickDefined(req.body, ['name', 'symbol']) as any });
    return success(res, unit, 'Unit created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateUnit = async (req: Request, res: Response) => {
  try {
    const name = req.body.name !== undefined ? String(req.body.name).trim() : undefined;
    const symbol = req.body.symbol !== undefined ? String(req.body.symbol).trim() : undefined;
    if (name === '' || symbol === '') {
      return error(res, 'Unit name and symbol cannot be empty', 400);
    }
    const unit = await prisma.unit.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(symbol !== undefined ? { symbol } : {}),
      },
    });
    return success(res, unit, 'Unit updated');
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

