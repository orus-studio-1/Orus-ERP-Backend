import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getLifecycleEvents = async (req: Request, res: Response) => {
  try {
    const where: any = {};
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.type) where.type = req.query.type;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.employeeLifecycleEvent.findMany({
      where,
      include: { employee: { include: { user: { select: { firstName: true, lastName: true } }, department: true, position: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createLifecycleEvent = async (req: Request, res: Response) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.body.employeeId } });
    if (!employee) return error(res, 'Employee not found', 404);
    const item = await prisma.employeeLifecycleEvent.create({
      data: {
        employeeId: employee.id,
        type: req.body.type,
        effectiveDate: new Date(req.body.effectiveDate),
        previousDepartmentId: employee.departmentId,
        previousPositionId: employee.positionId,
        previousSalary: employee.salary,
        newDepartmentId: req.body.newDepartmentId,
        newPositionId: req.body.newPositionId,
        newSalary: req.body.newSalary ? Number(req.body.newSalary) : undefined,
        reason: req.body.reason,
        notes: req.body.notes,
      },
    });
    return success(res, item, 'Lifecycle event created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateLifecycleEventStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const item = await prisma.$transaction(async (tx) => {
      const existing = await tx.employeeLifecycleEvent.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('Lifecycle event not found');
      if (existing.status !== 'DRAFT') throw new Error('Only draft lifecycle events can be submitted or cancelled');
      if (status === 'CANCELLED') {
        return tx.employeeLifecycleEvent.update({ where: { id: existing.id }, data: { status: 'CANCELLED' } });
      }
      if (status !== 'SUBMITTED') throw new Error('Invalid lifecycle status');
      const employeeData: any = {};
      if (existing.newDepartmentId) employeeData.departmentId = existing.newDepartmentId;
      if (existing.newPositionId) employeeData.positionId = existing.newPositionId;
      if (existing.newSalary) employeeData.salary = Number(existing.newSalary);
      if (existing.type === 'SEPARATION') {
        employeeData.status = 'TERMINATED';
        employeeData.terminatedDate = existing.effectiveDate;
      } else if (existing.type === 'ONBOARDING') {
        employeeData.status = 'ACTIVE';
      }
      await tx.employee.update({ where: { id: existing.employeeId }, data: employeeData });
      return tx.employeeLifecycleEvent.update({ where: { id: existing.id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
    });
    return success(res, item, `Lifecycle event ${status.toLowerCase()}`);
  } catch (err: any) {
    return error(res, err.message || 'Unable to update lifecycle event', 400);
  }
};

export const getHrDashboard = async (_req: Request, res: Response) => {
  try {
    const [employees, pendingLeaves, openPayrolls, activeDepartments] = await Promise.all([
      prisma.employee.count({ where: { status: { in: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] } } }),
      prisma.leaveRequest.count({ where: { status: 'PENDING' } }),
      prisma.payrollEntry.count({ where: { status: { in: ['DRAFT', 'SUBMITTED'] } } }),
      prisma.department.count({ where: { isActive: true } }),
    ]);
    return success(res, { employees, pendingLeaves, openPayrolls, activeDepartments });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
