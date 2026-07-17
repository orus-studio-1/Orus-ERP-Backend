import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { employeeInclude, getEmployeeForUser } from './shared';

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
