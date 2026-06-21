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
    const { email, password, firstName, lastName, phone, departmentId, positionId, managerId, hireDate, salary, salaryType, address, city, country, emergencyName, emergencyPhone } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return error(res, 'Email already registered', 400);

    const hashed = await bcrypt.hash(password || 'Employee@123', 10);
    const employeeId = await generateEmployeeId();

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, password: hashed, firstName, lastName, phone, role: 'EMPLOYEE' },
      });
      const emp = await tx.employee.create({
        data: {
          employeeId, userId: user.id, departmentId, positionId, managerId,
          hireDate: new Date(hireDate), salary, salaryType, address, city, country,
          emergencyName, emergencyPhone,
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
    const { firstName, lastName, phone, departmentId, positionId, managerId, salary, salaryType, status, address, city, country, emergencyName, emergencyPhone } = req.body;

    const emp = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!emp) return error(res, 'Employee not found', 404);

    const [, updated] = await Promise.all([
      prisma.user.update({ where: { id: emp.userId }, data: { firstName, lastName, phone } }),
      prisma.employee.update({
        where: { id: req.params.id },
        data: { departmentId, positionId, managerId, salary, salaryType, status, address, city, country, emergencyName, emergencyPhone },
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
    await prisma.employee.delete({ where: { id: req.params.id } });
    return success(res, null, 'Employee deleted');
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
    const lr = await prisma.leaveRequest.create({
      data: req.body,
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
    const lr = await prisma.leaveRequest.update({
      where: { id: req.params.id },
      data: { status, approvedBy, approvedAt: new Date() },
    });
    return success(res, lr, `Leave request ${status.toLowerCase()}`);
  } catch (err: any) {
    return handlePrismaError(res, err);
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

