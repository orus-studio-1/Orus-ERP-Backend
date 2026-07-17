import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getAttendance = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 30;
    const { employeeId, date, month, year } = req.query as any;
    const where: any = {};
    if (employeeId) where.employeeId = employeeId;
    if (date) where.date = { gte: new Date(date), lt: new Date(new Date(date).getTime() + 86400000) };
    if (month && year) {
      const start = new Date(parseInt(year), parseInt(month) - 1, 1);
      const end = new Date(parseInt(year), parseInt(month), 1);
      where.date = { gte: start, lt: end };
    }

    const [items, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } } },
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.attendance.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const markAttendance = async (req: Request, res: Response) => {
  try {
    const { employeeId, date, checkIn, checkOut, status, notes } = req.body;
    const hoursWorked = checkIn && checkOut
      ? (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 3600000
      : undefined;

    const attendance = await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId, date: new Date(date) } },
      update: { checkIn: checkIn ? new Date(checkIn) : undefined, checkOut: checkOut ? new Date(checkOut) : undefined, status, notes, hoursWorked },
      create: { employeeId, date: new Date(date), checkIn: checkIn ? new Date(checkIn) : undefined, checkOut: checkOut ? new Date(checkOut) : undefined, status, notes, hoursWorked },
    });
    return success(res, attendance, 'Attendance recorded');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
