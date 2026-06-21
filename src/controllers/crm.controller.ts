import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { AuthRequest } from '../middleware/auth';

// ---- LEADS ----
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

// ---- CONTACTS ----
export const getContacts = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { search } = req.query as any;
    const where: any = { isActive: true };
    if (search) where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.contact.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createContact = async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.create({ data: req.body });
    return success(res, contact, 'Contact created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateContact = async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.update({ where: { id: req.params.id }, data: req.body });
    return success(res, contact, 'Contact updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteContact = async (req: Request, res: Response) => {
  try {
    await prisma.contact.delete({ where: { id: req.params.id } });
    return success(res, null, 'Contact deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- OPPORTUNITIES ----
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

// ---- ACTIVITIES ----
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

