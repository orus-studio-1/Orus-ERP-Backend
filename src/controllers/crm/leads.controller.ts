import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';

export const getLeads = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, source, assignedToId, search } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (source) where.source = source;
    if (assignedToId) where.assignedToId = assignedToId;
    if (search) where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          createdBy: { select: { firstName: true, lastName: true } },
          assignedTo: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getLead = async (req: Request, res: Response) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        assignedTo: { select: { firstName: true, lastName: true } },
        activities: { include: { user: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } },
        opportunity: true,
      },
    });
    if (!lead) return error(res, 'Lead not found', 404);
    return success(res, lead);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createLead = async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.create({
      data: { ...req.body, createdById: req.user!.id },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        assignedTo: { select: { firstName: true, lastName: true } },
      },
    });
    return success(res, lead, 'Lead created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateLead = async (req: Request, res: Response) => {
  try {
    const lead = await prisma.lead.update({ where: { id: req.params.id }, data: req.body });
    return success(res, lead, 'Lead updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteLead = async (req: Request, res: Response) => {
  try {
    await prisma.lead.delete({ where: { id: req.params.id } });
    return success(res, null, 'Lead deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const convertLead = async (req: Request, res: Response) => {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return error(res, 'Lead not found', 404);

    const opportunity = await prisma.opportunity.create({
      data: {
        title: `${lead.firstName} ${lead.lastName} - ${lead.company || 'Opportunity'}`,
        leadId: lead.id,
        value: lead.value || 0,
        stage: 'PROSPECTING',
        probability: 10,
      },
    });

    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'CONVERTED' } });
    return success(res, opportunity, 'Lead converted to opportunity');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
