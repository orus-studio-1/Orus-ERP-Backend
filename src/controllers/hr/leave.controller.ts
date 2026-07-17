import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { dayStart, daysBetweenInclusive, getEmployeeForUser } from './shared';

export const getLeaveTypes = async (req: Request, res: Response) => {
  try {
    const types = await prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    return success(res, types);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createLeaveType = async (req: Request, res: Response) => {
  try {
    const lt = await prisma.leaveType.create({ data: req.body });
    return success(res, lt, 'Leave type created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- LEAVE REQUESTS ----
export const getLeaveRequests = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { employeeId, status } = req.query as any;
    const where: any = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if ((req as any).user?.role === 'EMPLOYEE') {
      const employee = await getEmployeeForUser((req as any).user.id);
      if (!employee) return error(res, 'Employee profile is not linked to this user', 404);
      where.employeeId = employee.id;
    }

    const [items, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        include: {
          employee: { include: { user: { select: { firstName: true, lastName: true } } } },
          leaveType: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.leaveRequest.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createLeaveRequest = async (req: Request, res: Response) => {
  try {
    const body = { ...req.body };
    if (!body.employeeId && (req as any).user?.id) {
      const employee = await getEmployeeForUser((req as any).user.id);
      if (!employee) return error(res, 'Employee profile is not linked to this user', 404);
      body.employeeId = employee.id;
    }
    const startDate = new Date(body.startDate);
    const endDate = new Date(body.endDate);
    body.days = Number(body.days || daysBetweenInclusive(startDate, endDate));
    const allocation = await prisma.leaveAllocation.findFirst({
      where: {
        employeeId: body.employeeId,
        leaveTypeId: body.leaveTypeId,
        fromDate: { lte: startDate },
        toDate: { gte: endDate },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (allocation && Number(allocation.balance) < body.days) {
      return error(res, `Insufficient leave balance. Available: ${allocation.balance}`, 400);
    }
    const lr = await prisma.leaveRequest.create({
      data: { ...body, startDate, endDate },
      include: { leaveType: true, employee: { include: { user: { select: { firstName: true, lastName: true } } } } },
    });
    return success(res, lr, 'Leave request submitted', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const approveLeaveRequest = async (req: Request, res: Response) => {
  try {
    const { status, approvedBy } = req.body;
    const lr = await prisma.$transaction(async (tx) => {
      const existing = await tx.leaveRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('Leave request not found');
      if (existing.status !== 'PENDING') throw new Error('Only pending leave requests can be approved or rejected');
      const updated = await tx.leaveRequest.update({
        where: { id: req.params.id },
        data: { status, approvedBy, approvedAt: new Date() },
      });
      if (status === 'APPROVED') {
        const allocation = await tx.leaveAllocation.findFirst({
          where: {
            employeeId: existing.employeeId,
            leaveTypeId: existing.leaveTypeId,
            fromDate: { lte: existing.startDate },
            toDate: { gte: existing.endDate },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (allocation) {
          const used = Number(allocation.used) + existing.days;
          const balance = Number(allocation.balance) - existing.days;
          if (balance < 0) throw new Error('Insufficient leave balance');
          await tx.leaveAllocation.update({ where: { id: allocation.id }, data: { used, balance } });
          await tx.leaveLedgerEntry.create({
            data: {
              employeeId: existing.employeeId,
              leaveTypeId: existing.leaveTypeId,
              leaveRequestId: existing.id,
              entryType: 'APPLICATION',
              leaves: -existing.days,
              balanceAfter: balance,
              notes: 'Leave request approved',
            },
          });
        }
        for (let cursor = dayStart(existing.startDate); cursor <= dayStart(existing.endDate); cursor = new Date(cursor.getTime() + 86400000)) {
          await tx.attendance.upsert({
            where: { employeeId_date: { employeeId: existing.employeeId, date: cursor } },
            update: { status: 'ON_LEAVE' },
            create: { employeeId: existing.employeeId, date: cursor, status: 'ON_LEAVE' },
          });
        }
      }
      return updated;
    });
    return success(res, lr, `Leave request ${status.toLowerCase()}`);
  } catch (err: any) {
    return error(res, err.message || 'Unable to update leave request', 400);
  }
};
