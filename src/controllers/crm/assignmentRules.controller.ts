import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';

const include = {
  assignTo: { select: { id: true, firstName: true, lastName: true, email: true } },
};

function ruleData(req: AuthRequest) {
  return {
    companyId: req.user?.companyId,
    name: req.body.name,
    isActive: req.body.isActive ?? true,
    priority: Number(req.body.priority ?? 100),
    source: req.body.source || null,
    city: req.body.city || null,
    country: req.body.country || null,
    minValue: req.body.minValue === '' || req.body.minValue === undefined ? null : Number(req.body.minValue),
    maxValue: req.body.maxValue === '' || req.body.maxValue === undefined ? null : Number(req.body.maxValue),
    assignToId: req.body.assignToId,
  };
}

export const getAssignmentRules = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const where = { companyId: req.user?.companyId || undefined };
    const [items, total] = await Promise.all([
      prisma.crmAssignmentRule.findMany({
        where,
        include,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.crmAssignmentRule.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createAssignmentRule = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.body.name || !req.body.assignToId) return error(res, 'Name and assignee are required', 400);
    const rule = await prisma.crmAssignmentRule.create({ data: ruleData(req), include });
    return success(res, rule, 'Assignment rule created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateAssignmentRule = async (req: AuthRequest, res: Response) => {
  try {
    const rule = await prisma.crmAssignmentRule.update({
      where: { id: req.params.id },
      data: ruleData(req),
      include,
    });
    return success(res, rule, 'Assignment rule updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteAssignmentRule = async (req: Request, res: Response) => {
  try {
    await prisma.crmAssignmentRule.delete({ where: { id: req.params.id } });
    return success(res, null, 'Assignment rule deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
