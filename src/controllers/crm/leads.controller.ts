import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';
import {
  csvToObjects,
  ensureOrganization,
  findDuplicateLead,
  leadInclude,
  logCrmActivity,
  normalizeLeadRow,
  resolveLeadAssignee,
  titleFromLead,
  validateLead,
} from './shared';

export const getLeads = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, source, assignedToId, search, mine } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (source) where.source = source;
    if (assignedToId) where.assignedToId = assignedToId;
    if (mine === 'true' && (req as AuthRequest).user?.id) where.assignedToId = (req as AuthRequest).user!.id;
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
          organization: true,
          createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
          _count: { select: { activities: true } },
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
        ...leadInclude,
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
    const normalized = normalizeLeadRow(req.body);
    const validation = validateLead(normalized);
    if (validation) return error(res, validation, 400);

    const lead = await prisma.$transaction(async (tx) => {
      const duplicate = await findDuplicateLead(tx, normalized);
      if (duplicate && !req.body.allowDuplicate) throw new Error(`Duplicate lead exists for ${duplicate.email || duplicate.phone}`);
      const organization = await ensureOrganization(tx, normalized, req.user?.companyId, req.user!.id);
      const assignedToId = req.body.assignedToId || await resolveLeadAssignee(tx, normalized, req.user?.companyId, req.user!.id);
      const created = await tx.lead.create({
        data: {
          ...req.body,
          ...normalized,
          title: titleFromLead({ ...req.body, ...normalized }),
          organizationId: organization?.id,
          createdById: req.user!.id,
          assignedToId,
        },
        include: leadInclude,
      });
      await logCrmActivity(tx, req.user!.id, {
        type: 'NOTE',
        subject: 'Lead created',
        description: `Created lead ${created.title}`,
        leadId: created.id,
      });
      return created;
    });
    return success(res, lead, 'Lead created', 201);
  } catch (err: any) {
    if (err.message?.startsWith('Duplicate lead')) return error(res, err.message, 409);
    return handlePrismaError(res, err);
  }
};

export const updateLead = async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.$transaction(async (tx) => {
      const existing = await tx.lead.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('Lead not found');
      const organization = req.body.company ? await ensureOrganization(tx, req.body, req.user?.companyId, req.user?.id) : null;
      const data: any = { ...req.body };
      if (organization) data.organizationId = organization.id;
      if (req.body.status === 'QUALIFIED' && existing.status !== 'QUALIFIED') data.qualifiedAt = new Date();
      if (req.body.status === 'CONTACTED' && existing.status !== 'CONTACTED') data.lastContactedAt = new Date();
      const updated = await tx.lead.update({ where: { id: req.params.id }, data, include: leadInclude });
      if (req.body.status && req.body.status !== existing.status) {
        await logCrmActivity(tx, req.user!.id, {
          type: 'STATUS_CHANGE',
          subject: `Lead status changed to ${req.body.status}`,
          description: `${existing.status} → ${req.body.status}`,
          leadId: updated.id,
          metadata: { before: existing.status, after: req.body.status },
        });
      }
      return updated;
    });
    return success(res, lead, 'Lead updated');
  } catch (err: any) {
    if (err.message === 'Lead not found') return error(res, err.message, 404);
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

export const convertLead = async (req: AuthRequest, res: Response) => {
  try {
    const opportunity = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: req.params.id } });
      if (!lead) throw new Error('Lead not found');
      if (lead.status === 'CONVERTED') throw new Error('Lead is already converted');
      const contact = await tx.contact.create({
        data: {
          leadId: lead.id,
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone: lead.phone,
          company: lead.company,
          organizationId: lead.organizationId,
          notes: lead.notes,
        },
      });
      const created = await tx.opportunity.create({
        data: {
          title: req.body.title || `${lead.firstName} ${lead.lastName} - ${lead.company || 'Opportunity'}`,
          leadId: lead.id,
          contactId: contact.id,
          organizationId: lead.organizationId,
          value: Number(req.body.value ?? lead.value ?? 0),
          currency: req.body.currency || 'USD',
          stage: 'QUALIFICATION',
          probability: Number(req.body.probability ?? 25),
          expectedClose: req.body.expectedClose ? new Date(req.body.expectedClose) : undefined,
          notes: req.body.notes || lead.notes,
        },
      });
      await tx.lead.update({ where: { id: lead.id }, data: { status: 'CONVERTED' } });
      await logCrmActivity(tx, req.user!.id, {
        type: 'CONVERSION',
        subject: 'Lead converted to opportunity',
        description: `Converted into ${created.title}`,
        leadId: lead.id,
        opportunityId: created.id,
      });
      return tx.opportunity.findUnique({ where: { id: created.id }, include: { contact: true, lead: true, organization: true } });
    });
    return success(res, opportunity, 'Lead converted to opportunity');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const qualifyLead = async (req: AuthRequest, res: Response) => {
  try {
    const opportunity = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: req.params.id }, include: { opportunity: true, contacts: true } });
      if (!lead) throw new Error('Lead not found');
      if (lead.opportunity) return tx.opportunity.findUnique({ where: { id: lead.opportunity.id }, include: { contact: true, lead: true, organization: true } });

      const contact = lead.contacts[0] || await tx.contact.create({
        data: {
          leadId: lead.id,
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone: lead.phone,
          company: lead.company,
          city: lead.city,
          country: lead.country,
          organizationId: lead.organizationId,
          notes: lead.notes,
        },
      });
      const created = await tx.opportunity.create({
        data: {
          title: req.body.title || `${lead.firstName} ${lead.lastName} - ${lead.company || 'Opportunity'}`,
          leadId: lead.id,
          contactId: contact.id,
          organizationId: lead.organizationId,
          value: Number(req.body.value ?? lead.value ?? 0),
          currency: req.body.currency || 'USD',
          stage: 'QUALIFICATION',
          probability: Number(req.body.probability ?? 25),
          expectedClose: req.body.expectedClose ? new Date(req.body.expectedClose) : undefined,
          notes: req.body.notes || lead.notes,
        },
      });
      await tx.lead.update({ where: { id: lead.id }, data: { status: 'CONVERTED', qualifiedAt: new Date() } });
      await logCrmActivity(tx, req.user!.id, {
        type: 'CONVERSION',
        subject: 'Lead qualified into opportunity',
        description: `Created contact and opportunity ${created.title}`,
        leadId: lead.id,
        contactId: contact.id,
        opportunityId: created.id,
      });
      return tx.opportunity.findUnique({ where: { id: created.id }, include: { contact: true, lead: true, organization: true } });
    });
    return success(res, opportunity, 'Lead qualified and converted');
  } catch (err: any) {
    if (err.message) return error(res, err.message, err.message.includes('not found') ? 404 : 400);
    return handlePrismaError(res, err);
  }
};

export const markLeadLost = async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.$transaction(async (tx) => {
      const existing = await tx.lead.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('Lead not found');
      const updated = await tx.lead.update({
        where: { id: existing.id },
        data: { status: 'UNQUALIFIED', lostReason: req.body.lostReason || req.body.reason || 'Not qualified' },
        include: leadInclude,
      });
      await logCrmActivity(tx, req.user!.id, {
        type: 'STATUS_CHANGE',
        subject: 'Lead marked lost',
        description: updated.lostReason,
        leadId: existing.id,
        metadata: { before: existing.status, after: 'UNQUALIFIED' },
      });
      return updated;
    });
    return success(res, lead, 'Lead marked lost');
  } catch (err: any) {
    if (err.message === 'Lead not found') return error(res, err.message, 404);
    return handlePrismaError(res, err);
  }
};

export const previewLeadImport = async (req: AuthRequest, res: Response) => {
  try {
    const csvText = req.body.csvText || req.body.content || '';
    if (!csvText.trim()) return error(res, 'CSV content is required', 400);
    const rows = csvToObjects(csvText).slice(0, 100);
    const preview = [];
    for (const row of rows) {
      const normalized = normalizeLeadRow(row.raw);
      const validation = validateLead(normalized);
      const duplicate = validation ? null : await findDuplicateLead(prisma, normalized);
      preview.push({ rowNo: row.rowNo, raw: row.raw, normalized, status: validation ? 'FAILED' : duplicate ? 'DUPLICATE' : 'READY', error: validation, duplicate });
    }
    return success(res, { rows: preview, totalRows: csvToObjects(csvText).length }, 'CSV preview generated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const importLeads = async (req: AuthRequest, res: Response) => {
  try {
    const csvText = req.body.csvText || req.body.content || '';
    const fileName = req.body.fileName || 'leads.csv';
    const duplicateMode = req.body.duplicateMode || 'skip';
    if (!csvText.trim()) return error(res, 'CSV content is required', 400);
    const parsed = csvToObjects(csvText);

    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.leadImportBatch.create({
        data: { fileName, status: 'PROCESSING', totalRows: parsed.length, importedById: req.user!.id, companyId: req.user?.companyId },
      });
      const counts = { createdRows: 0, skippedRows: 0, failedRows: 0, duplicateRows: 0 };

      for (const row of parsed) {
        const normalized = normalizeLeadRow(row.raw);
        const validation = validateLead(normalized);
        if (validation) {
          counts.failedRows += 1;
          await tx.leadImportRow.create({ data: { batchId: batch.id, rowNo: row.rowNo, rawData: row.raw, normalizedData: normalized, status: 'FAILED', error: validation } });
          continue;
        }
        const duplicate = await findDuplicateLead(tx, normalized);
        if (duplicate && duplicateMode !== 'create') {
          counts.duplicateRows += 1;
          await tx.leadImportRow.create({ data: { batchId: batch.id, rowNo: row.rowNo, rawData: row.raw, normalizedData: normalized, status: 'DUPLICATE', duplicateLeadId: duplicate.id, error: 'Duplicate lead' } });
          continue;
        }
        const organization = await ensureOrganization(tx, normalized, req.user?.companyId, req.user!.id);
        const assignedToId = req.body.assignedToId || await resolveLeadAssignee(tx, normalized, req.user?.companyId, req.user!.id);
        const lead = await tx.lead.create({
          data: {
            ...normalized,
            title: titleFromLead(normalized),
            organizationId: organization?.id,
            createdById: req.user!.id,
            assignedToId,
            importBatchId: batch.id,
            importRowNo: row.rowNo,
          },
        });
        counts.createdRows += 1;
        await tx.leadImportRow.create({ data: { batchId: batch.id, rowNo: row.rowNo, rawData: row.raw, normalizedData: normalized, status: 'CREATED', leadId: lead.id } });
      }
      await tx.leadImportBatch.update({ where: { id: batch.id }, data: { ...counts, status: 'COMPLETED', completedAt: new Date() } });
      await logCrmActivity(tx, req.user!.id, {
        type: 'IMPORT',
        subject: 'Lead CSV imported',
        description: `${counts.createdRows} leads created from ${fileName}`,
        metadata: counts,
      });
      return tx.leadImportBatch.findUnique({ where: { id: batch.id }, include: { rows: { take: 200, orderBy: { rowNo: 'asc' } } } });
    }, { timeout: 60000 });
    return success(res, result, 'Lead import completed', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getLeadImports = async (_req: Request, res: Response) => {
  try {
    const imports = await prisma.leadImportBatch.findMany({
      include: { importedBy: { select: { firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return success(res, imports);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getLeadImport = async (req: Request, res: Response) => {
  try {
    const batch = await prisma.leadImportBatch.findUnique({
      where: { id: req.params.id },
      include: { rows: { orderBy: { rowNo: 'asc' } }, importedBy: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!batch) return error(res, 'Import batch not found', 404);
    return success(res, batch);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
