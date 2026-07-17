import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getSalaryComponents = async (_req: Request, res: Response) => {
  try {
    const items = await prisma.salaryComponent.findMany({ orderBy: { name: 'asc' } });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createSalaryComponent = async (req: Request, res: Response) => {
  try {
    const item = await prisma.salaryComponent.create({ data: req.body });
    return success(res, item, 'Salary component created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getSalaryStructures = async (_req: Request, res: Response) => {
  try {
    const items = await prisma.salaryStructure.findMany({
      include: { components: { include: { salaryComponent: true }, orderBy: { idx: 'asc' } }, _count: { select: { assignments: true } } },
      orderBy: { name: 'asc' },
    });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createSalaryStructure = async (req: Request, res: Response) => {
  try {
    const { name, description, currency, components = [] } = req.body;
    const item = await prisma.salaryStructure.create({
      data: {
        name, description, currency: currency || 'USD',
        components: {
          create: components.map((c: any, idx: number) => ({
            salaryComponentId: c.salaryComponentId,
            amount: Number(c.amount || 0),
            formula: c.formula,
            idx,
          })),
        },
      },
      include: { components: { include: { salaryComponent: true } } },
    });
    return success(res, item, 'Salary structure created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const assignSalaryStructure = async (req: Request, res: Response) => {
  try {
    const { employeeId, salaryStructureId, baseSalary, fromDate } = req.body;
    const item = await prisma.$transaction(async (tx) => {
      await tx.salaryStructureAssignment.updateMany({ where: { employeeId, isActive: true }, data: { isActive: false, toDate: new Date(fromDate) } });
      return tx.salaryStructureAssignment.create({
        data: { employeeId, salaryStructureId, baseSalary: Number(baseSalary || 0), fromDate: new Date(fromDate), isActive: true },
        include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, salaryStructure: true },
      });
    });
    return success(res, item, 'Salary structure assigned', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
