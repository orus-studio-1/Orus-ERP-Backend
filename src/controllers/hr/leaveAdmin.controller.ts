import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getLeaveAllocations = async (req: Request, res: Response) => {
  try {
    const where: any = { employee: { user: { companyId: (req as any).user?.companyId || '__missing_company__' } } };
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    const items = await prisma.leaveAllocation.findMany({
      where,
      include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, leaveType: true, leavePeriod: true },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createLeaveAllocation = async (req: Request, res: Response) => {
  try {
    const { employeeId, leaveTypeId, leavePeriodId, allocated, fromDate, toDate, notes } = req.body;
    const amount = Number(allocated || 0);
    if (amount <= 0) return error(res, 'Allocated leave must be greater than zero', 400);
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, user: { companyId: (req as any).user?.companyId || '__missing_company__' } } });
    if (!employee) return error(res, 'Employee not found in your company', 404);
    const item = await prisma.$transaction(async (tx) => {
      const allocation = await tx.leaveAllocation.create({
        data: {
          employeeId, leaveTypeId, leavePeriodId,
          allocated: amount, used: 0, balance: amount,
          fromDate: new Date(fromDate), toDate: new Date(toDate),
        },
      });
      await tx.leaveLedgerEntry.create({
        data: {
          employeeId, leaveTypeId, entryType: 'ALLOCATION',
          leaves: amount, balanceAfter: amount, notes: notes || 'Manual leave allocation',
        },
      });
      return allocation;
    });
    return success(res, item, 'Leave allocated', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateLeaveAllocation = async (req: Request, res: Response) => {
  try {
    const { allocated, fromDate, toDate } = req.body;
    const existing = await prisma.leaveAllocation.findUnique({ where: { id: req.params.id } });
    if (!existing) return error(res, 'Leave allocation not found', 404);

    const newAllocated = allocated !== undefined ? Number(allocated) : Number(existing.allocated);
    const newBalance = newAllocated - Number(existing.used);
    if (newBalance < 0) return error(res, 'Allocated leaves cannot be less than already used leaves', 400);

    const updated = await prisma.leaveAllocation.update({
      where: { id: req.params.id },
      data: {
        allocated: newAllocated,
        balance: newBalance,
        ...(fromDate ? { fromDate: new Date(fromDate) } : {}),
        ...(toDate ? { toDate: new Date(toDate) } : {}),
      },
      include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, leaveType: true },
    });
    return success(res, updated, 'Leave allocation updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteLeaveAllocation = async (req: Request, res: Response) => {
  try {
    const existing = await prisma.leaveAllocation.findUnique({ where: { id: req.params.id } });
    if (!existing) return error(res, 'Leave allocation not found', 404);
    if (Number(existing.used) > 0) return error(res, 'Cannot delete an allocation that has already been used for approved leaves', 400);

    await prisma.leaveAllocation.delete({ where: { id: req.params.id } });
    return success(res, null, 'Leave allocation deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getLeaveLedger = async (req: Request, res: Response) => {
  try {
    const where: any = { employee: { user: { companyId: (req as any).user?.companyId || '__missing_company__' } } };
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.leaveTypeId) where.leaveTypeId = req.query.leaveTypeId;
    const items = await prisma.leaveLedgerEntry.findMany({
      where,
      include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, leaveType: true },
      orderBy: { transactionDate: 'desc' },
      take: 200,
    });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createLeavePolicy = async (req: Request, res: Response) => {
  try {
    const { name, description, details = [] } = req.body;
    const policy = await prisma.leavePolicy.create({
      data: {
        name, description,
        details: { create: details.map((d: any) => ({ leaveTypeId: d.leaveTypeId, annualAllocation: Number(d.annualAllocation || 0) })) },
      },
      include: { details: { include: { leaveType: true } } },
    });
    return success(res, policy, 'Leave policy created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getLeavePolicies = async (_req: Request, res: Response) => {
  try {
    const items = await prisma.leavePolicy.findMany({ include: { details: { include: { leaveType: true } } }, orderBy: { name: 'asc' } });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateLeavePolicy = async (req: Request, res: Response) => {
  try {
    const { name, description, details } = req.body;
    const policy = await prisma.$transaction(async (tx) => {
      if (details && Array.isArray(details)) {
        await tx.leavePolicyDetail.deleteMany({ where: { leavePolicyId: req.params.id } });
        return tx.leavePolicy.update({
          where: { id: req.params.id },
          data: {
            ...(name ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            details: { create: details.map((d: any) => ({ leaveTypeId: d.leaveTypeId, annualAllocation: Number(d.annualAllocation || 0) })) },
          },
          include: { details: { include: { leaveType: true } } },
        });
      }
      return tx.leavePolicy.update({
        where: { id: req.params.id },
        data: {
          ...(name ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
        },
        include: { details: { include: { leaveType: true } } },
      });
    });
    return success(res, policy, 'Leave policy updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteLeavePolicy = async (req: Request, res: Response) => {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.leavePolicyDetail.deleteMany({ where: { leavePolicyId: req.params.id } });
      await tx.leavePolicy.delete({ where: { id: req.params.id } });
    });
    return success(res, null, 'Leave policy deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

