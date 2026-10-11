import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { pickDefined } from '../../utils/payload';
import { AuthRequest } from '../../middleware/auth';
import { computeContactPriority, emptyContactPriority, tierRank } from '../../services/crm/customerPriority.service';
import { addMissingPhones, ensureOrganization, logCrmActivity, parsePhones, phoneRowsOf, primaryPhone, replacePhones } from './shared';

// A bad phone number is the caller's mistake (400), not a server error.
const isPhoneProblem = (message?: string) => Boolean(message?.startsWith('Invalid phone number'));

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

    // Tier and won deals come from computeContactPriority. Sorting or filtering by them needs every
    // contact's figures, so that path ranks in memory and then pages the result.
    const { sort, tier } = req.query as any;
    const priority = await computeContactPriority();
    const withPriority = (rows: any[]) => rows.map((row) => ({ ...row, priority: priority.get(row.id) || emptyContactPriority() }));
    const include = { organization: true, lead: true, phones: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] } };

    if (sort === 'priority' || tier) {
      const wantedTier = String(tier || '').toUpperCase();
      const candidates = await prisma.contact.findMany({ where, select: { id: true, createdAt: true } });
      const matching = candidates
        .filter((row) => !wantedTier || (wantedTier === 'NONE' ? (priority.get(row.id) || emptyContactPriority()).tier === null : (priority.get(row.id) || emptyContactPriority()).tier === wantedTier))
        .sort((x, y) => {
          const a1 = priority.get(x.id) || emptyContactPriority();
          const b1 = priority.get(y.id) || emptyContactPriority();
          return tierRank(a1.tier) - tierRank(b1.tier) || b1.score - a1.score || y.createdAt.getTime() - x.createdAt.getTime();
        });
      const ids = matching.slice((page - 1) * limit, page * limit).map((row) => row.id);
      const rows = await prisma.contact.findMany({ where: { id: { in: ids } }, include });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return paginated(res, withPriority(ids.map((id) => byId.get(id)).filter(Boolean) as any[]), matching.length, page, limit);
    }

    const [items, total] = await Promise.all([
      prisma.contact.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.contact.count({ where }),
    ]);
    return paginated(res, withPriority(items), total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getContact = async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: req.params.id },
      include: {
        organization: true,
        lead: true,
        phones: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        opportunities: { include: { customer: true, organization: true, quotation: true, salesOrder: true }, orderBy: { updatedAt: 'desc' } },
        activities: {
          include: {
            user: { select: { firstName: true, lastName: true, email: true } },
            lead: { select: { id: true, title: true } },
            opportunity: { select: { id: true, title: true } },
            organization: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        customers: true,
      },
    });
    if (!contact) return error(res, 'Contact not found', 404);
    return success(res, { ...contact, priority: (await computeContactPriority()).get(contact.id) || emptyContactPriority() });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createContact = async (req: AuthRequest, res: Response) => {
  try {
    const contact = await prisma.$transaction(async (tx) => {
      const lead = req.body.leadId ? await tx.lead.findUnique({ where: { id: req.body.leadId }, include: { phones: true } }) : null;
      if (req.body.leadId && !lead) throw new Error('Lead not found');
      const { phones: leadPhones, ...leadFields } = (lead || {}) as any;
      const source = { ...leadFields, ...req.body };
      // The numbers the user entered, else the lead's own numbers.
      const parsed = req.body.phones !== undefined || !leadPhones?.length ? parsePhones(source, source.country) : { phones: phoneRowsOf(leadPhones) };
      if ('error' in parsed && parsed.error) throw new Error(parsed.error);
      const main = primaryPhone(parsed.phones);
      const mobileNumber = parsed.phones.find((phone) => phone.type === 'MOBILE')?.number;
      const organization = source.organizationId ? null : await ensureOrganization(tx, source, req.user?.companyId, req.user?.id);
      const created = await tx.contact.create({
        data: {
          firstName: source.firstName,
          lastName: source.lastName,
          email: source.email,
          phone: main?.number ?? source.phone,
          mobile: mobileNumber ?? source.mobile,
          company: source.company,
          leadId: lead?.id || req.body.leadId || undefined,
          organizationId: source.organizationId || organization?.id,
          position: source.position,
          address: source.address,
          city: source.city,
          country: source.country,
          notes: source.notes,
        },
        include: { organization: true, lead: true },
      });
      await replacePhones(tx, { contactId: created.id }, created.companyId, parsed.phones);
      if (lead) {
        await tx.lead.update({ where: { id: lead.id }, data: { status: lead.status === 'LEAD' ? 'OPEN' : lead.status, lastContactedAt: new Date() } });
        await logCrmActivity(tx, req.user!.id, {
          type: 'CONVERSION',
          subject: 'Contact created from lead',
          description: `${created.firstName} ${created.lastName} linked to ${lead.title}`,
          leadId: lead.id,
          contactId: created.id,
          organizationId: created.organizationId,
        });
      }
      return created;
    });
    return success(res, contact, 'Contact created', 201);
  } catch (err: any) {
    if (err.message === 'Lead not found') return error(res, err.message, 404);
    if (isPhoneProblem(err.message)) return error(res, err.message, 400);
    return handlePrismaError(res, err);
  }
};

export const openLeadContact = async (req: AuthRequest, res: Response) => {
  try {
    const contact = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: req.params.id }, include: { phones: true, contacts: { where: { isActive: true }, orderBy: { createdAt: 'asc' }, take: 1 } } });
      if (!lead) throw new Error('Lead not found');
      if (lead.contacts[0]) return lead.contacts[0];

      const organization = lead.organizationId ? null : await ensureOrganization(tx, lead, req.user?.companyId, req.user?.id);
      const created = await tx.contact.create({
        data: {
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone: lead.phone,
          company: lead.company,
          leadId: lead.id,
          organizationId: lead.organizationId || organization?.id,
          city: lead.city,
          country: lead.country,
          notes: lead.notes,
        },
      });
      await addMissingPhones(tx, { contactId: created.id }, lead.companyId, phoneRowsOf(lead.phones));
      await tx.lead.update({ where: { id: lead.id }, data: { status: lead.status === 'LEAD' ? 'OPEN' : lead.status, lastContactedAt: new Date() } });
      await logCrmActivity(tx, req.user!.id, {
        type: 'NOTE',
        subject: 'Contact profile opened from lead',
        description: `Created the primary contact profile for ${lead.title}`,
        leadId: lead.id,
        contactId: created.id,
        organizationId: created.organizationId,
      });
      return created;
    });
    return success(res, contact, 'Lead contact ready');
  } catch (err: any) {
    if (err.message === 'Lead not found') return error(res, err.message, 404);
    return handlePrismaError(res, err);
  }
};

export const updateContact = async (req: Request, res: Response) => {
  try {
    const data: any = pickDefined(req.body, ['firstName', 'lastName', 'email', 'phone', 'mobile', 'jobTitle', 'department', 'address', 'city', 'state', 'country', 'zip', 'notes', 'organizationId', 'ownerId', 'isPrimary', 'isActive']);
    // An explicit phone list replaces all numbers; the primary one is mirrored on phone / mobile.
    const parsed = req.body.phones !== undefined ? parsePhones({ phones: req.body.phones }, req.body.country) : null;
    if (parsed?.error) return error(res, parsed.error, 400);
    if (parsed) {
      data.phone = primaryPhone(parsed.phones)?.number ?? null;
      data.mobile = parsed.phones.find((phone) => phone.type === 'MOBILE')?.number ?? null;
    }
    const contact = await prisma.$transaction(async (tx) => {
      const updated = await tx.contact.update({ where: { id: req.params.id }, data });
      if (parsed) await replacePhones(tx, { contactId: updated.id }, updated.companyId, parsed.phones);
      return tx.contact.findUnique({ where: { id: updated.id }, include: { phones: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } } });
    });
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
