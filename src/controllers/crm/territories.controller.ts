import { Response } from 'express';
import prisma from '../../lib/prisma';
import { AuthRequest } from '../../middleware/auth';
import { error, success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

// The managed territory list. Leads, organizations, customers and assignment rules store the
// territory by name, so renaming a territory renames it on all of them in one transaction.
const companyOf = (req: AuthRequest) => req.user?.companyId || '';
const cleanName = (value: unknown) => String(value ?? '').trim();

async function usageOf(tx: any, companyId: string, name: string) {
  const where = { companyId, territory: { equals: name, mode: 'insensitive' as const } };
  const [leads, organizations, customers, rules] = await Promise.all([
    tx.lead.count({ where }),
    tx.crmOrganization.count({ where }),
    tx.customer.count({ where }),
    tx.crmAssignmentRule.count({ where }),
  ]);
  return { leads, organizations, customers, rules, total: leads + organizations + customers + rules };
}

export const listTerritories = async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.crmTerritory.findMany({
      where: { companyId: companyOf(req), ...(req.query.all === 'true' ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return success(res, rows);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createTerritory = async (req: AuthRequest, res: Response) => {
  try {
    const name = cleanName(req.body.name);
    if (!name) return error(res, 'Territory name is required', 400);
    if (name.length > 100) return error(res, 'Territory name is too long (100 characters at most)', 400);
    const clash = await prisma.crmTerritory.findFirst({ where: { companyId: companyOf(req), name: { equals: name, mode: 'insensitive' } } });
    if (clash) return error(res, `Territory "${clash.name}" already exists`, 409);
    const row = await prisma.crmTerritory.create({ data: { companyId: companyOf(req), name, sortOrder: Number.isFinite(Number(req.body.sortOrder)) ? Number(req.body.sortOrder) : 100 } });
    return success(res, row, 'Territory created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateTerritory = async (req: AuthRequest, res: Response) => {
  try {
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.crmTerritory.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
      if (!existing) throw new Error('Territory not found');
      const data: Record<string, any> = {};
      if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
      if (req.body.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))) data.sortOrder = Number(req.body.sortOrder);
      const name = req.body.name === undefined ? existing.name : cleanName(req.body.name);
      if (!name) throw new Error('Territory name is required');
      if (name !== existing.name) {
        const clash = await tx.crmTerritory.findFirst({ where: { companyId: companyOf(req), id: { not: existing.id }, name: { equals: name, mode: 'insensitive' } } });
        if (clash) throw new Error(`Territory "${clash.name}" already exists`);
        data.name = name;
        const where = { companyId: companyOf(req), territory: { equals: existing.name, mode: 'insensitive' as const } };
        const change = { territory: name };
        await tx.lead.updateMany({ where, data: change });
        await tx.crmOrganization.updateMany({ where, data: change });
        await tx.customer.updateMany({ where, data: change });
        await tx.crmAssignmentRule.updateMany({ where, data: change });
      }
      return tx.crmTerritory.update({ where: { id: existing.id }, data });
    });
    return success(res, row, 'Territory updated');
  } catch (err: any) {
    if (err.message === 'Territory not found') return error(res, err.message, 404);
    if (err.message?.startsWith('Territory ') || err.message === 'Territory name is required') return error(res, err.message, err.message.includes('already exists') ? 409 : 400);
    return handlePrismaError(res, err);
  }
};

export const deleteTerritory = async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.crmTerritory.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
    if (!existing) return error(res, 'Territory not found', 404);
    const usage = await usageOf(prisma, companyOf(req), existing.name);
    if (usage.total) return error(res, `Territory "${existing.name}" is used by ${usage.leads} lead(s), ${usage.organizations} organization(s), ${usage.customers} customer(s) and ${usage.rules} assignment rule(s). Mark it inactive instead.`, 409);
    await prisma.crmTerritory.delete({ where: { id: existing.id } });
    return success(res, null, 'Territory deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
