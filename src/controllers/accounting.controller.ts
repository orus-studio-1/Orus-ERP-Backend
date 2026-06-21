import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { generateJournalNo } from '../utils/generate';

// ---- ACCOUNTS ----
export const getAccounts = async (req: Request, res: Response) => {
  try {
    const { type, search } = req.query as any;
    const where: any = {};
    if (type) where.type = type;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const accounts = await prisma.account.findMany({
      where,
      include: { parent: { select: { name: true, code: true } }, children: { select: { id: true, name: true, code: true } } },
      orderBy: { code: 'asc' },
    });
    return success(res, accounts);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getAccount = async (req: Request, res: Response) => {
  try {
    const account = await prisma.account.findUnique({
      where: { id: req.params.id },
      include: { parent: true, children: true },
    });
    if (!account) return error(res, 'Account not found', 404);
    return success(res, account);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createAccount = async (req: Request, res: Response) => {
  try {
    const account = await prisma.account.create({ data: req.body });
    return success(res, account, 'Account created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateAccount = async (req: Request, res: Response) => {
  try {
    const account = await prisma.account.update({ where: { id: req.params.id }, data: req.body });
    return success(res, account, 'Account updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteAccount = async (req: Request, res: Response) => {
  try {
    await prisma.account.delete({ where: { id: req.params.id } });
    return success(res, null, 'Account deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- JOURNAL ENTRIES ----
export const getJournalEntries = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, search } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (search) where.OR = [
      { entryNumber: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.journalEntry.findMany({
        where,
        include: { lines: { include: { debitAccount: true, creditAccount: true } } },
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.journalEntry.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getJournalEntry = async (req: Request, res: Response) => {
  try {
    const entry = await prisma.journalEntry.findUnique({
      where: { id: req.params.id },
      include: { lines: { include: { debitAccount: true, creditAccount: true } } },
    });
    if (!entry) return error(res, 'Journal entry not found', 404);
    return success(res, entry);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createJournalEntry = async (req: Request, res: Response) => {
  try {
    const { date, description, reference, lines } = req.body;
    const entryNumber = await generateJournalNo();

    const totalDebit = lines.reduce((s: number, l: any) => s + (l.debit || 0), 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + (l.credit || 0), 0);

    const entry = await prisma.journalEntry.create({
      data: {
        entryNumber,
        date: new Date(date),
        description,
        reference,
        totalDebit,
        totalCredit,
        lines: { create: lines },
      },
      include: { lines: { include: { debitAccount: true, creditAccount: true } } },
    });
    return success(res, entry, 'Journal entry created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const postJournalEntry = async (req: Request, res: Response) => {
  try {
    const entry = await prisma.journalEntry.findUnique({
      where: { id: req.params.id },
      include: { lines: true },
    });
    if (!entry) return error(res, 'Entry not found', 404);
    if (entry.status !== 'DRAFT') return error(res, 'Only draft entries can be posted', 400);

    await prisma.journalEntry.update({ where: { id: entry.id }, data: { status: 'POSTED' } });
    return success(res, null, 'Journal entry posted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const cancelJournalEntry = async (req: Request, res: Response) => {
  try {
    await prisma.journalEntry.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
    return success(res, null, 'Journal entry cancelled');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteJournalEntry = async (req: Request, res: Response) => {
  try {
    const entry = await prisma.journalEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) return error(res, 'Entry not found', 404);
    if (entry.status === 'POSTED') return error(res, 'Cannot delete posted entry', 400);
    await prisma.journalEntry.delete({ where: { id: req.params.id } });
    return success(res, null, 'Journal entry deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- FISCAL YEARS ----
export const getFiscalYears = async (req: Request, res: Response) => {
  try {
    const years = await prisma.fiscalYear.findMany({ include: { periods: true }, orderBy: { startDate: 'desc' } });
    return success(res, years);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createFiscalYear = async (req: Request, res: Response) => {
  try {
    const year = await prisma.fiscalYear.create({ data: req.body, include: { periods: true } });
    return success(res, year, 'Fiscal year created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- REPORTS ----
export const getTrialBalance = async (req: Request, res: Response) => {
  try {
    const accounts = await prisma.account.findMany({
      where: { isActive: true },
      include: {
        debitLines: { select: { debit: true } },
        creditLines: { select: { credit: true } },
      },
      orderBy: { code: 'asc' },
    });

    const report = accounts.map(acc => ({
      id: acc.id,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      totalDebit: acc.debitLines.reduce((s, l) => s + l.debit, 0),
      totalCredit: acc.creditLines.reduce((s, l) => s + l.credit, 0),
    }));

    return success(res, report);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

