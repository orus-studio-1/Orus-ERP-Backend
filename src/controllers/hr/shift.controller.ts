import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getShiftTypes = async (_req: Request, res: Response) => {
  try {
    const items = await prisma.shiftType.findMany({ orderBy: { name: 'asc' } });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createShiftType = async (req: Request, res: Response) => {
  try {
    const item = await prisma.shiftType.create({ data: req.body });
    return success(res, item, 'Shift type created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const assignShift = async (req: Request, res: Response) => {
  try {
    const { employeeId, shiftTypeId, startDate, endDate } = req.body;
    const item = await prisma.shiftAssignment.create({
      data: { employeeId, shiftTypeId, startDate: new Date(startDate), endDate: endDate ? new Date(endDate) : undefined },
      include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, shiftType: true },
    });
    return success(res, item, 'Shift assigned', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
