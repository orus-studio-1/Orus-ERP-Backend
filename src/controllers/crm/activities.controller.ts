import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';

const activityInclude = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  lead: { select: { id: true, title: true, firstName: true, lastName: true, company: true, status: true } },
  contact: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  opportunity: { select: { id: true, title: true, stage: true, value: true } },
  organization: { select: { id: true, name: true } },
};

function toDate(value?: string | null) {
  return value ? new Date(value) : undefined;
}

function normalizeActivityPayload(body: any, userId?: string) {
  return {
    type: body.type,
    subject: String(body.subject || '').trim(),
    description: body.description || undefined,
    dueDate: toDate(body.dueDate),
    completedAt: toDate(body.completedAt),
    status: body.status || 'PLANNED',
    metadata: body.metadata,
    organizationId: body.organizationId || undefined,
    leadId: body.leadId || undefined,
    contactId: body.contactId || undefined,
    opportunityId: body.opportunityId || undefined,
    userId: body.userId || userId,
  };
}

function validateActivity(data: any) {
  if (!data.type) return 'Activity type is required';
  if (!data.subject) return 'Subject is required';
  if (!data.leadId && !data.contactId && !data.opportunityId && !data.organizationId) {
    return 'Activity must be linked to a lead, contact, organization, or opportunity';
  }
  return null;
}

async function touchLeadAfterActivity(tx: any, activity: any) {
  if (!activity.leadId) return;
  const contactTypes = ['CALL', 'EMAIL', 'MEETING', 'FOLLOW_UP'];
  const data: any = {};
  if (contactTypes.includes(activity.type) && activity.status === 'COMPLETED') data.lastContactedAt = activity.completedAt || new Date();
  if (activity.type === 'CALL' || activity.type === 'EMAIL') data.status = 'CONTACTED';
  if (Object.keys(data).length) await tx.lead.update({ where: { id: activity.leadId }, data });
}

export const getActivities = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { leadId, contactId, opportunityId, organizationId, type, status, fromDate, toDate: untilDate, q } = req.query as any;
    const where: any = {};
    if (leadId) where.leadId = leadId;
    if (contactId) where.contactId = contactId;
    if (opportunityId) where.opportunityId = opportunityId;
    if (organizationId) where.organizationId = organizationId;
    if (type) where.type = type;
    if (status) where.status = status;
    if (fromDate || untilDate) where.createdAt = { ...(fromDate ? { gte: new Date(fromDate) } : {}), ...(untilDate ? { lte: new Date(untilDate) } : {}) };
    if (q) where.OR = [{ subject: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }];

    const [items, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        include: activityInclude,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
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
    const payload = normalizeActivityPayload(req.body, req.user!.id);
    const validationError = validateActivity(payload);
    if (validationError) return error(res, validationError, 400);

    const activity = await prisma.$transaction(async (tx) => {
      const created = await tx.activity.create({ data: payload, include: activityInclude });
      await touchLeadAfterActivity(tx, created);
      return created;
    });
    return success(res, activity, 'Activity created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getLeadActivities = async (req: Request, res: Response) => {
  try {
    const activities = await prisma.activity.findMany({
      where: { leadId: req.params.id },
      include: activityInclude,
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
    });
    const now = new Date();
    const open = activities.filter((item: any) => !['COMPLETED', 'CANCELLED'].includes(item.status));
    const completed = activities.filter((item: any) => item.status === 'COMPLETED');
    const overdue = open.filter((item: any) => item.dueDate && item.dueDate < now);
    const nextActivity = open.find((item: any) => item.dueDate);
    return success(res, {
      activities,
      summary: {
        total: activities.length,
        open: open.length,
        completed: completed.length,
        overdue: overdue.length,
        nextActivity,
        lastCompleted: completed[0] || null,
      },
    });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createLeadActivity = async (req: AuthRequest, res: Response) => {
  req.body.leadId = req.params.id;
  return createActivity(req, res);
};

export const updateActivity = async (req: Request, res: Response) => {
  try {
    const data = normalizeActivityPayload(req.body);
    delete (data as any).userId;
    Object.keys(data).forEach((key) => data[key as keyof typeof data] === undefined && delete data[key as keyof typeof data]);
    const activity = await prisma.activity.update({ where: { id: req.params.id }, data, include: activityInclude });
    return success(res, activity, 'Activity updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const completeActivity = async (req: AuthRequest, res: Response) => {
  try {
    const activity = await prisma.$transaction(async (tx) => {
      const completed = await tx.activity.update({
        where: { id: req.params.id },
        data: {
          status: 'COMPLETED',
          completedAt: req.body.completedAt ? new Date(req.body.completedAt) : new Date(),
          description: req.body.description === undefined ? undefined : req.body.description,
        },
        include: activityInclude,
      });
      await touchLeadAfterActivity(tx, completed);
      if (req.body.followUpSubject && completed.leadId) {
        await tx.activity.create({
          data: {
            type: req.body.followUpType || 'FOLLOW_UP',
            subject: req.body.followUpSubject,
            description: req.body.followUpDescription,
            dueDate: req.body.followUpDueDate ? new Date(req.body.followUpDueDate) : undefined,
            status: 'PLANNED',
            leadId: completed.leadId,
            contactId: completed.contactId,
            organizationId: completed.organizationId,
            opportunityId: completed.opportunityId,
            userId: req.user!.id,
          },
        });
      }
      return completed;
    });
    return success(res, activity, 'Activity completed');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const cancelActivity = async (req: Request, res: Response) => {
  try {
    const activity = await prisma.activity.update({
      where: { id: req.params.id },
      data: { status: 'CANCELLED', metadata: req.body.reason ? { cancelReason: req.body.reason } : undefined },
      include: activityInclude,
    });
    return success(res, activity, 'Activity cancelled');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteActivity = async (req: Request, res: Response) => {
  try {
    const activity = await prisma.activity.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
    return success(res, activity, 'Activity cancelled');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
