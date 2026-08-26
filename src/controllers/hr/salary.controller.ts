import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, error } from '../../utils/response';
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
    const { name, type, description, defaultAmount, formula, isTaxable } = req.body;
    if (!name || !type) return error(res, 'name and type are required', 400);
    if (!['EARNING', 'DEDUCTION', 'TAX', 'BENEFIT'].includes(type)) return error(res, 'Invalid salary component type', 400);
    const item = await prisma.salaryComponent.create({
      data: {
        name: String(name).trim(),
        type,
        description,
        defaultAmount: defaultAmount === '' || defaultAmount == null ? undefined : Number(defaultAmount),
        formula: formula || undefined,
        isTaxable: Boolean(isTaxable),
      },
    });
    return success(res, item, 'Salary component created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateSalaryComponent = async (req: Request, res: Response) => {
  try {
    const { name, type, description, defaultAmount, formula, isTaxable } = req.body;
    if (type && !['EARNING', 'DEDUCTION', 'TAX', 'BENEFIT'].includes(type)) return error(res, 'Invalid salary component type', 400);
    const item = await prisma.salaryComponent.update({
      where: { id: req.params.id },
      data: {
        ...(name ? { name: String(name).trim() } : {}),
        ...(type ? { type } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(defaultAmount !== undefined ? { defaultAmount: defaultAmount === '' || defaultAmount == null ? null : Number(defaultAmount) } : {}),
        ...(formula !== undefined ? { formula: formula || null } : {}),
        ...(isTaxable !== undefined ? { isTaxable: Boolean(isTaxable) } : {}),
      },
    });
    return success(res, item, 'Salary component updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteSalaryComponent = async (req: Request, res: Response) => {
  try {
    const inUse = await prisma.salaryStructureComponent.count({ where: { salaryComponentId: req.params.id } });
    if (inUse > 0) return error(res, 'Cannot delete a salary component that is part of active salary structures', 400);

    await prisma.salaryComponent.delete({ where: { id: req.params.id } });
    return success(res, null, 'Salary component deleted');
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
    if (!name) return error(res, 'Structure name is required', 400);
    if (!Array.isArray(components) || !components.length) return error(res, 'Add at least one salary component', 400);
    const uniqueComponentIds = new Set(components.map((component: any) => component.salaryComponentId).filter(Boolean));
    if (uniqueComponentIds.size !== components.length) return error(res, 'Each salary component can appear only once in a structure', 400);
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

export const updateSalaryStructure = async (req: Request, res: Response) => {
  try {
    const { name, description, currency, isActive, components } = req.body;
    const item = await prisma.$transaction(async (tx) => {
      if (components && Array.isArray(components)) {
        await tx.salaryStructureComponent.deleteMany({ where: { salaryStructureId: req.params.id } });
        return tx.salaryStructure.update({
          where: { id: req.params.id },
          data: {
            ...(name ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(currency ? { currency } : {}),
            ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
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
      }
      return tx.salaryStructure.update({
        where: { id: req.params.id },
        data: {
          ...(name ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(currency ? { currency } : {}),
          ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
        },
        include: { components: { include: { salaryComponent: true } } },
      });
    });
    return success(res, item, 'Salary structure updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteSalaryStructure = async (req: Request, res: Response) => {
  try {
    const assignmentsCount = await prisma.salaryStructureAssignment.count({ where: { salaryStructureId: req.params.id } });
    if (assignmentsCount > 0) return error(res, 'Cannot delete salary structure assigned to employees', 400);

    await prisma.$transaction(async (tx) => {
      await tx.salaryStructureComponent.deleteMany({ where: { salaryStructureId: req.params.id } });
      await tx.salaryStructure.delete({ where: { id: req.params.id } });
    });
    return success(res, null, 'Salary structure deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const assignSalaryStructure = async (req: Request, res: Response) => {
  try {
    const { employeeId, salaryStructureId, baseSalary, fromDate, toDate } = req.body;
    if (!employeeId || !salaryStructureId || !fromDate) return error(res, 'employeeId, salaryStructureId and fromDate are required', 400);
    const start = new Date(fromDate);
    const end = toDate ? new Date(toDate) : undefined;
    if (end && end < start) return error(res, 'toDate cannot be before fromDate', 400);
    const item = await prisma.$transaction(async (tx) => {
      const [employee, structure] = await Promise.all([
        tx.employee.findUnique({ where: { id: employeeId } }),
        tx.salaryStructure.findUnique({ where: { id: salaryStructureId }, include: { components: true } }),
      ]);
      if (!employee) throw new Error('Employee not found');
      if (!structure || !structure.isActive) throw new Error('Active salary structure not found');
      if (!structure.components.length) throw new Error('Salary structure has no components');
      await tx.salaryStructureAssignment.updateMany({ where: { employeeId, isActive: true }, data: { isActive: false, toDate: start } });
      return tx.salaryStructureAssignment.create({
        data: { employeeId, salaryStructureId, baseSalary: Number(baseSalary || employee.salary || 0), fromDate: start, toDate: end, isActive: true },
        include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, salaryStructure: true },
      });
    });
    return success(res, item, 'Salary structure assigned', 201);
  } catch (err: any) {
    if (err.message) return error(res, err.message, 400);
    return handlePrismaError(res, err);
  }
};

