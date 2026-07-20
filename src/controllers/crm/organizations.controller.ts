import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';

export const getOrganizations = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { search } = req.query as any;
    const where: any = { isActive: true };
    if (search) where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { industry: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
    const [items, total] = await Promise.all([
      prisma.crmOrganization.findMany({
        where,
        include: { owner: { select: { firstName: true, lastName: true } }, _count: { select: { leads: true, contacts: true, opportunities: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.crmOrganization.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getOrganization = async (req: Request, res: Response) => {
  try {
    const organization = await prisma.crmOrganization.findUnique({
      where: { id: req.params.id },
      include: {
        owner: { select: { firstName: true, lastName: true, email: true } },
        leads: { include: { assignedTo: { select: { firstName: true, lastName: true } } }, orderBy: { updatedAt: 'desc' } },
        contacts: { orderBy: { updatedAt: 'desc' } },
        opportunities: { include: { customer: true, quotation: true, salesOrder: true }, orderBy: { updatedAt: 'desc' } },
        activities: {
          include: {
            user: { select: { firstName: true, lastName: true, email: true } },
            lead: { select: { id: true, title: true } },
            opportunity: { select: { id: true, title: true } },
            contact: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!organization) return error(res, 'Organization not found', 404);
    return success(res, organization);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createOrganization = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.body.name) return error(res, 'Organization name is required', 400);
    const organization = await prisma.crmOrganization.create({
      data: { ...req.body, companyId: req.user?.companyId, ownerId: req.body.ownerId || req.user?.id },
    });
    return success(res, organization, 'Organization created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateOrganization = async (req: Request, res: Response) => {
  try {
    const organization = await prisma.crmOrganization.update({ where: { id: req.params.id }, data: req.body });
    return success(res, organization, 'Organization updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteOrganization = async (req: Request, res: Response) => {
  try {
    await prisma.crmOrganization.update({ where: { id: req.params.id }, data: { isActive: false } });
    return success(res, null, 'Organization archived');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
