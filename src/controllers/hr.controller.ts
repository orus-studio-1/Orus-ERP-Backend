import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generateEmployeeId } from '../utils/generate';

// ---- EMPLOYEES ----
export const getEmployees = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { departmentId, status, search } = req.query as any;
    const where: any = {};
    if (departmentId) where.departmentId = departmentId;
    if (status) where.status = status;
    if (search) where.OR = [
      { user: { firstName: { contains: search, mode: 'insensitive' } } },
      { user: { lastName: { contains: search, mode: 'insensitive' } } },
      { employeeId: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          user: { select: { firstName: true, lastName: true, email: true, avatar: true } },
          department: true,
          position: true,
          manager: { include: { user: { select: { firstName: true, lastName: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.employee.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getEmployee = async (req: Request, res: Response) => {
  try {
    const emp = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true, avatar: true } },
        department: true,
        position: true,
        manager: { include: { user: { select: { firstName: true, lastName: true } } } },
        attendance: { take: 30, orderBy: { date: 'desc' } },
        leaveRequests: { include: { leaveType: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!emp) return error(res, 'Employee not found', 404);
    return success(res, emp);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createEmployee = async (req: Request, res: Response) => {
  try {
    const {
      email, password, firstName, lastName, phone, departmentId, positionId, managerId,
      hireDate, salary, salaryType, address, city, country, emergencyName, emergencyPhone,
      role, employmentType, branch, grade, gender, dateOfBirth, maritalStatus,
      workLocation, personalEmail, companyEmail, noticePeriodDays, bankAccount, bankName, taxId,
    } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return error(res, 'Email already registered', 400);

    const hashed = await bcrypt.hash(password || 'Employee@123', 10);
    const employeeId = await generateEmployeeId();

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, password: hashed, firstName, lastName, phone, role: role || 'EMPLOYEE' },
      });
      const emp = await tx.employee.create({
        data: {
          employeeId, userId: user.id, departmentId, positionId, managerId,
          hireDate: new Date(hireDate), salary, salaryType, address, city, country,
          emergencyName, emergencyPhone, employmentType, branch, grade, gender,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          maritalStatus, workLocation, personalEmail, companyEmail,
          noticePeriodDays: noticePeriodDays ? Number(noticePeriodDays) : undefined,
          bankAccount, bankName, taxId,
        },
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: true, position: true,
        },
      });
      return emp;
    });

    return success(res, result, 'Employee created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateEmployee = async (req: Request, res: Response) => {
  try {
    const {
      firstName, lastName, phone, departmentId, positionId, managerId, salary, salaryType,
      status, address, city, country, emergencyName, emergencyPhone, employmentType,
      branch, grade, gender, dateOfBirth, maritalStatus, workLocation, personalEmail,
      companyEmail, noticePeriodDays, bankAccount, bankName, taxId,
    } = req.body;

    const emp = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!emp) return error(res, 'Employee not found', 404);

    const [, updated] = await Promise.all([
      prisma.user.update({ where: { id: emp.userId }, data: { firstName, lastName, phone } }),
      prisma.employee.update({
        where: { id: req.params.id },
        data: {
          departmentId, positionId, managerId, salary, salaryType, status, address, city, country,
          emergencyName, emergencyPhone, employmentType, branch, grade, gender,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          maritalStatus, workLocation, personalEmail, companyEmail,
          noticePeriodDays: noticePeriodDays ? Number(noticePeriodDays) : undefined,
          bankAccount, bankName, taxId,
        },
        include: { user: { select: { firstName: true, lastName: true, email: true } }, department: true, position: true },
      }),
    ]);
    return success(res, updated, 'Employee updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteEmployee = async (req: Request, res: Response) => {
  try {
    const employee = await prisma.employee.update({
      where: { id: req.params.id },
      data: { status: 'TERMINATED', terminatedDate: new Date() },
    });
    return success(res, employee, 'Employee terminated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- DEPARTMENTS ----
export const getDepartments = async (req: Request, res: Response) => {
  try {
    const depts = await prisma.department.findMany({
      include: { _count: { select: { employees: true } }, positions: true },
      orderBy: { name: 'asc' },
    });
    return success(res, depts);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createDepartment = async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.create({ data: req.body });
    return success(res, dept, 'Department created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateDepartment = async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.update({ where: { id: req.params.id }, data: req.body });
    return success(res, dept, 'Department updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteDepartment = async (req: Request, res: Response) => {
  try {
    await prisma.department.delete({ where: { id: req.params.id } });
    return success(res, null, 'Department deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- POSITIONS ----
export const getPositions = async (req: Request, res: Response) => {
  try {
    const positions = await prisma.position.findMany({
      include: { department: true, _count: { select: { employees: true } } },
      orderBy: { title: 'asc' },
    });
    return success(res, positions);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createPosition = async (req: Request, res: Response) => {
  try {
    const pos = await prisma.position.create({ data: req.body, include: { department: true } });
    return success(res, pos, 'Position created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deletePosition = async (req: Request, res: Response) => {
  try {
    await prisma.position.delete({ where: { id: req.params.id } });
    return success(res, null, 'Position deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- ATTENDANCE ----
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

// ---- LEAVE TYPES ----
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

// ---- PAYROLL ----
export const getPayrolls = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { month, year, status, employeeId } = req.query as any;
    const where: any = {};
    if (month) where.month = parseInt(month);
    if (year) where.year = parseInt(year);
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;

    const [items, total] = await Promise.all([
      prisma.payroll.findMany({
        where,
        include: {
          employee: { include: { user: { select: { firstName: true, lastName: true } } } },
          items: true,
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payroll.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const generatePayroll = async (req: Request, res: Response) => {
  try {
    const { month, year } = req.body;
    const employees = await prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      include: { user: { select: { firstName: true, lastName: true } } },
    });

    const payrolls = await Promise.all(
      employees.map(async (emp) => {
        const existing = await prisma.payroll.findUnique({
          where: { employeeId_month_year: { employeeId: emp.id, month, year } },
        });
        if (existing) return existing;

        const tax = emp.salary * 0.1;
        const netSalary = emp.salary - tax;

        return prisma.payroll.create({
          data: {
            employeeId: emp.id, month, year,
            basicSalary: emp.salary, tax, netSalary,
            items: {
              create: [
                { type: 'EARNING', name: 'Basic Salary', amount: emp.salary },
                { type: 'TAX', name: 'Income Tax (10%)', amount: tax },
              ],
            },
          },
          include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, items: true },
        });
      })
    );

    return success(res, payrolls, 'Payroll generated', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updatePayrollStatus = async (req: Request, res: Response) => {
  try {
    const { status, payDate } = req.body;
    const payroll = await prisma.payroll.update({
      where: { id: req.params.id },
      data: { status, payDate: payDate ? new Date(payDate) : undefined },
    });
    return success(res, payroll, 'Payroll status updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

const dayStart = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const daysBetweenInclusive = (start: Date, end: Date) => {
  const ms = dayStart(end).getTime() - dayStart(start).getTime();
  return Math.max(1, Math.floor(ms / 86400000) + 1);
};

const employeeInclude = {
  user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatar: true, role: true } },
  department: true,
  position: true,
  manager: { include: { user: { select: { firstName: true, lastName: true } } } },
};

async function getEmployeeForUser(userId?: string) {
  if (!userId) return null;
  return prisma.employee.findUnique({ where: { userId }, include: employeeInclude });
}

export const getMyHrProfile = async (req: any, res: Response) => {
  try {
    const employee = await getEmployeeForUser(req.user?.id);
    if (!employee) return error(res, 'Employee profile is not linked to this user', 404);
    return success(res, employee);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateMyHrProfile = async (req: any, res: Response) => {
  try {
    const employee = await getEmployeeForUser(req.user?.id);
    if (!employee) return error(res, 'Employee profile is not linked to this user', 404);
    const { phone, address, city, country, emergencyName, emergencyPhone, bankAccount, bankName, personalEmail } = req.body;
    const updated = await prisma.$transaction(async (tx) => {
      if (phone) await tx.user.update({ where: { id: employee.userId }, data: { phone } });
      return tx.employee.update({
        where: { id: employee.id },
        data: { address, city, country, emergencyName, emergencyPhone, bankAccount, bankName, personalEmail },
        include: employeeInclude,
      });
    });
    return success(res, updated, 'Profile updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getMyAttendance = async (req: any, res: Response) => {
  try {
    const employee = await getEmployeeForUser(req.user?.id);
    if (!employee) return error(res, 'Employee profile is not linked to this user', 404);
    const records = await prisma.attendance.findMany({
      where: { employeeId: employee.id },
      orderBy: { date: 'desc' },
      take: 60,
      include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } } },
    });
    return success(res, records);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createEmployeeCheckin = async (req: any, res: Response) => {
  try {
    const employee = await getEmployeeForUser(req.user?.id);
    if (!employee) return error(res, 'Employee profile is not linked to this user', 404);
    const { logType, time, deviceId, location, notes } = req.body;
    if (!['IN', 'OUT'].includes(logType)) return error(res, 'logType must be IN or OUT', 400);
    const stamp = time ? new Date(time) : new Date();
    const workDate = dayStart(stamp);

    const result = await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.upsert({
        where: { employeeId_date: { employeeId: employee.id, date: workDate } },
        update: logType === 'IN'
          ? { checkIn: stamp, status: 'PRESENT' }
          : { checkOut: stamp, status: 'PRESENT' },
        create: {
          employeeId: employee.id,
          date: workDate,
          checkIn: logType === 'IN' ? stamp : undefined,
          checkOut: logType === 'OUT' ? stamp : undefined,
          status: 'PRESENT',
        },
      });
      const latest = await tx.attendance.findUnique({ where: { employeeId_date: { employeeId: employee.id, date: workDate } } });
      const hoursWorked = latest?.checkIn && latest?.checkOut
        ? (latest.checkOut.getTime() - latest.checkIn.getTime()) / 3600000
        : undefined;
      const updatedAttendance = hoursWorked
        ? await tx.attendance.update({ where: { id: attendance.id }, data: { hoursWorked } })
        : attendance;
      const checkin = await tx.employeeCheckin.create({
        data: { employeeId: employee.id, logType, time: stamp, deviceId, location, notes, attendanceId: updatedAttendance.id },
      });
      return { checkin, attendance: updatedAttendance };
    });
    return success(res, result, `${logType === 'IN' ? 'Checked in' : 'Checked out'} successfully`, 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

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

export const getLeaveAllocations = async (req: Request, res: Response) => {
  try {
    const where: any = {};
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

export const getLeaveLedger = async (req: Request, res: Response) => {
  try {
    const where: any = {};
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

async function nextPayrollNumber(tx: any, prefix: string) {
  const count = await tx.payrollEntry.count();
  return `${prefix}-${String(count + 1).padStart(5, '0')}`;
}

async function nextSlipNumber(tx: any, month: number, year: number, index: number) {
  const count = await tx.salarySlip.count();
  return `SAL-${year}-${String(month).padStart(2, '0')}-${String(count + index + 1).padStart(5, '0')}`;
}

export const getPayrollEntries = async (req: Request, res: Response) => {
  try {
    const where: any = {};
    if (req.query.month) where.month = Number(req.query.month);
    if (req.query.year) where.year = Number(req.query.year);
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.payrollEntry.findMany({
      where,
      include: { salarySlips: { include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } } } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const generatePayrollEntry = async (req: Request, res: Response) => {
  try {
    const { month, year, notes } = req.body;
    const existing = await prisma.payrollEntry.findUnique({
      where: { month_year: { month: Number(month), year: Number(year) } },
      include: { salarySlips: { include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, items: true } } },
    });
    if (existing) return success(res, existing, 'Payroll entry already exists');

    const employees = await prisma.employee.findMany({
      where: { status: { in: ['ACTIVE', 'PROBATION'] } },
      include: {
        user: { select: { firstName: true, lastName: true } },
        salaryAssignments: {
          where: { isActive: true },
          include: { salaryStructure: { include: { components: { include: { salaryComponent: true }, orderBy: { idx: 'asc' } } } } },
          take: 1,
        },
      },
    });

    const entry = await prisma.$transaction(async (tx) => {
      const payrollEntry = await tx.payrollEntry.create({
        data: { payrollNo: await nextPayrollNumber(tx, `PAY-${year}`), month: Number(month), year: Number(year), notes },
      });
      let totalGross = 0;
      let totalDeduction = 0;
      let totalNet = 0;

      for (let i = 0; i < employees.length; i += 1) {
        const emp: any = employees[i];
        const assignment = emp.salaryAssignments[0];
        const base = Number(assignment?.baseSalary || emp.salary || 0);
        const components = assignment?.salaryStructure?.components?.length
          ? assignment.salaryStructure.components
          : [{ salaryComponent: { id: null, type: 'EARNING', name: 'Basic Salary' }, amount: base, idx: 0 }];

        const lines = components.map((c: any, idx: number) => {
          const rawAmount = Number(c.amount || 0);
          const amount = rawAmount === 0 && c.salaryComponent?.type === 'EARNING' ? base : rawAmount;
          return {
            salaryComponentId: c.salaryComponent?.id || undefined,
            type: c.salaryComponent?.type || 'EARNING',
            name: c.salaryComponent?.name || 'Basic Salary',
            amount,
            idx,
          };
        });
        const gross = lines.filter((l: any) => ['EARNING', 'BENEFIT'].includes(l.type)).reduce((sum: number, l: any) => sum + l.amount, 0);
        const deductions = lines.filter((l: any) => ['DEDUCTION', 'TAX'].includes(l.type)).reduce((sum: number, l: any) => sum + l.amount, 0);
        const net = gross - deductions;
        totalGross += gross;
        totalDeduction += deductions;
        totalNet += net;

        await tx.salarySlip.create({
          data: {
            slipNo: await nextSlipNumber(tx, Number(month), Number(year), i),
            payrollEntryId: payrollEntry.id,
            employeeId: emp.id,
            month: Number(month),
            year: Number(year),
            currency: assignment?.salaryStructure?.currency || 'USD',
            grossPay: gross,
            totalDeduction: deductions,
            netPay: net,
            items: { create: lines },
          },
        });
      }

      return tx.payrollEntry.update({
        where: { id: payrollEntry.id },
        data: { totalGross, totalDeduction, totalNet },
        include: { salarySlips: { include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, items: true } } },
      });
    });
    return success(res, entry, 'Payroll entry generated', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updatePayrollEntryStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const entry = await prisma.$transaction(async (tx) => {
      const existing = await tx.payrollEntry.findUnique({ where: { id: req.params.id }, include: { salarySlips: true } });
      if (!existing) throw new Error('Payroll entry not found');
      if (existing.status === 'CANCELLED') throw new Error('Cancelled payroll entries cannot be changed');
      const data: any = { status };
      const slipData: any = { status };
      if (status === 'PAID') {
        slipData.paymentDate = new Date();
      }
      await tx.salarySlip.updateMany({ where: { payrollEntryId: existing.id }, data: slipData });
      return tx.payrollEntry.update({ where: { id: existing.id }, data, include: { salarySlips: true } });
    });
    return success(res, entry, 'Payroll entry status updated');
  } catch (err: any) {
    return error(res, err.message || 'Unable to update payroll entry', 400);
  }
};

export const getSalarySlips = async (req: any, res: Response) => {
  try {
    const where: any = {};
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.month) where.month = Number(req.query.month);
    if (req.query.year) where.year = Number(req.query.year);
    if (req.query.mine === 'true') {
      const employee = await getEmployeeForUser(req.user?.id);
      if (!employee) return error(res, 'Employee profile is not linked to this user', 404);
      where.employeeId = employee.id;
    }
    const items = await prisma.salarySlip.findMany({
      where,
      include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } }, items: true, payrollEntry: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return success(res, items);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getMySalarySlips = async (req: any, res: Response) => {
  req.query.mine = 'true';
  return getSalarySlips(req, res);
};

export const getSalarySlip = async (req: any, res: Response) => {
  try {
    const item = await prisma.salarySlip.findUnique({
      where: { id: req.params.id },
      include: { employee: { include: employeeInclude }, items: true, payrollEntry: true },
    });
    if (!item) return error(res, 'Salary slip not found', 404);
    if (req.user?.role === 'EMPLOYEE' && item.employee.userId !== req.user.id) return error(res, 'Insufficient permissions', 403);
    return success(res, item);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

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
