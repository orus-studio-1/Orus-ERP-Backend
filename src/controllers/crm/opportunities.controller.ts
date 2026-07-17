import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';

export const getOpportunities = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { stage, search } = req.query as any;
    const where: any = {};
    if (stage) where.stage = stage;
    if (search) where.title = { contains: search, mode: 'insensitive' };

    const [items, total] = await Promise.all([
      prisma.opportunity.findMany({
        where,
        include: { contact: true, lead: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.opportunity.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createOpportunity = async (req: Request, res: Response) => {
  try {
    const opp = await prisma.opportunity.create({ data: req.body, include: { contact: true } });
    return success(res, opp, 'Opportunity created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateOpportunity = async (req: Request, res: Response) => {
  try {
    const opp = await prisma.opportunity.update({ where: { id: req.params.id }, data: req.body });
    return success(res, opp, 'Opportunity updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteOpportunity = async (req: Request, res: Response) => {
  try {
    await prisma.opportunity.delete({ where: { id: req.params.id } });
    return success(res, null, 'Opportunity deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
