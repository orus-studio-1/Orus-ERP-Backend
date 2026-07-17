import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';

export const getActivities = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { leadId, contactId, opportunityId, type, status } = req.query as any;
    const where: any = {};
    if (leadId) where.leadId = leadId;
    if (contactId) where.contactId = contactId;
    if (opportunityId) where.opportunityId = opportunityId;
    if (type) where.type = type;
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        include: { user: { select: { firstName: true, lastName: true } }, lead: true, contact: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.activity.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createActivity = async (req: AuthRequest, res: Response) => {
  try {
    const activity = await prisma.activity.create({
      data: { ...req.body, userId: req.body.userId || req.user!.id },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    return success(res, activity, 'Activity created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateActivity = async (req: Request, res: Response) => {
  try {
    const activity = await prisma.activity.update({ where: { id: req.params.id }, data: req.body });
    return success(res, activity, 'Activity updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteActivity = async (req: Request, res: Response) => {
  try {
    await prisma.activity.delete({ where: { id: req.params.id } });
    return success(res, null, 'Activity deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
