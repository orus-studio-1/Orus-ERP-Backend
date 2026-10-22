import { Prisma } from '@prisma/client';

export const leadInclude = {
  organization: true,
  phones: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
  activities: {
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    orderBy: { createdAt: 'desc' as const },
  },
  contacts: { include: { organization: true }, orderBy: { createdAt: 'desc' as const } },
  opportunity: { include: { contact: true, organization: true, customer: true, quotation: true, salesOrder: true } },
};

export const opportunityInclude = {
  organization: true,
  contact: true,
  lead: { select: { id: true, firstName: true, lastName: true, email: true, company: true } },
  customer: { select: { id: true, customerNo: true, name: true } },
  quotation: { select: { id: true, quotationNo: true, status: true, total: true } },
  salesOrder: { select: { id: true, orderNo: true, status: true, total: true } },
  items: { include: { product: { select: { id: true, sku: true, name: true, salePrice: true, taxRate: true } } } },
  activities: {
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    orderBy: { createdAt: 'desc' as const },
  },
};

// ---- Lead status -----------------------------------------------------------------------------
export const LEAD_STATUSES = ['LEAD', 'OPEN', 'REPLIED', 'OPPORTUNITY', 'QUOTATION', 'LOST_QUOTATION', 'INTERESTED', 'CONVERTED', 'DO_NOT_CONTACT', 'UNQUALIFIED'] as const;
// Statuses of a lead that is still being worked (dashboards, stale-lead checks).
// A lead in one of these statuses is finished (converted, rejected, or its quotation was lost), so the
// same person coming back with a new enquiry is a new lead, not a duplicate. Do Not Contact still counts.
export const CLOSED_LEAD_STATUSES = ['CONVERTED', 'UNQUALIFIED', 'LOST_QUOTATION'];
export const OPEN_LEAD_STATUSES = ['LEAD', 'OPEN', 'REPLIED', 'INTERESTED', 'OPPORTUNITY', 'QUOTATION'];
// Statuses that mean the lead has shown real interest (report "qualified" count).
export const QUALIFIED_LEAD_STATUSES = ['INTERESTED', 'OPPORTUNITY', 'QUOTATION', 'CONVERTED'];
// Older clients, CSV files and API callers still send the previous names.
const LEGACY_LEAD_STATUS: Record<string, string> = { NEW: 'LEAD', CONTACTED: 'OPEN', QUALIFIED: 'INTERESTED' };

// "Do not contact", "do-not-contact" and DO_NOT_CONTACT all mean the same status. Returns undefined
// for an empty value and null for a value that is not a lead status.
export function normalizeLeadStatus(value: unknown): string | null | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const key = text.toUpperCase().replace(/[\s-]+/g, '_');
  const mapped = LEGACY_LEAD_STATUS[key] || key;
  return (LEAD_STATUSES as readonly string[]).includes(mapped) ? mapped : null;
}

// ---- Phone numbers ---------------------------------------------------------------------------
export const PHONE_TYPES = ['MOBILE', 'WORK', 'HOME', 'WHATSAPP', 'OTHER'] as const;
export type PhoneRow = { number: string; normalized: string; type: string; isPrimary: boolean };

// Reads raw.phones (a list of { number, type, isPrimary }) or, when there is none, the single
// raw.phone / raw.mobile fields older callers send. Exactly one number ends up primary.
export function parsePhones(raw: any, country?: string | null): { phones: PhoneRow[]; error?: string } {
  // An explicit list (even an empty one) is the whole answer; the single phone / mobile fields are
  // only read when no list was sent.
  let list: any[] = [];
  if (Array.isArray(raw?.phones)) list = raw.phones;
  else {
    if (raw?.phone) list.push({ number: raw.phone, type: 'OTHER', isPrimary: true });
    if (raw?.mobile) list.push({ number: raw.mobile, type: 'MOBILE', isPrimary: !raw?.phone });
  }
  const phones: PhoneRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const number = String(typeof item === 'string' ? item : item?.number ?? '').trim();
    if (!number) continue;
    const normalized = (normalizePhone(number, country) || '').replace(/\D/g, '');
    if (normalized.length < 7 || normalized.length > 15) return { phones: [], error: `Invalid phone number: ${number}` };
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const type = String(item?.type || 'MOBILE').toUpperCase();
    phones.push({ number, normalized, type: (PHONE_TYPES as readonly string[]).includes(type) ? type : 'OTHER', isPrimary: Boolean(item?.isPrimary) });
  }
  if (phones.length) {
    const primary = phones.findIndex((phone) => phone.isPrimary);
    phones.forEach((phone, index) => { phone.isPrimary = index === (primary >= 0 ? primary : 0); });
  }
  return { phones };
}

export const primaryPhone = (phones: PhoneRow[]) => phones.find((phone) => phone.isPrimary) || phones[0];

// Rows read back from the database, in the shape parsePhones returns.
export const phoneRowsOf = (rows: any[] = []): PhoneRow[] => rows.map((row) => ({ number: row.number, normalized: row.normalized, type: row.type, isPrimary: row.isPrimary }));

// Replaces every phone of one lead, contact or organization.
export async function replacePhones(tx: any, owner: { leadId?: string; contactId?: string; organizationId?: string }, companyId: string | null | undefined, phones: PhoneRow[]) {
  await tx.crmPhone.deleteMany({ where: owner });
  if (phones.length) await tx.crmPhone.createMany({ data: phones.map((phone) => ({ companyId: companyId || undefined, ...owner, number: phone.number, normalized: phone.normalized, type: phone.type, isPrimary: phone.isPrimary })) });
}

// Adds the numbers the owner does not have yet (used when a lead's data is copied to its contact or
// organization). The first number becomes primary only when the owner had none.
export async function addMissingPhones(tx: any, owner: { leadId?: string; contactId?: string; organizationId?: string }, companyId: string | null | undefined, phones: PhoneRow[]) {
  if (!phones.length) return;
  const existing = await tx.crmPhone.findMany({ where: owner, select: { normalized: true } });
  const have = new Set<string>(existing.map((row: any) => row.normalized));
  const fresh = phones.filter((phone) => !have.has(phone.normalized));
  if (!fresh.length) return;
  await tx.crmPhone.createMany({ data: fresh.map((phone, index) => ({ companyId: companyId || undefined, ...owner, number: phone.number, normalized: phone.normalized, type: phone.type, isPrimary: existing.length === 0 && index === 0 })) });
}

// ---- Territory -------------------------------------------------------------------------------
// Returns the territory exactly as it is spelled in the managed list, null for an empty value, and
// throws when the name is not in the list.
export async function resolveTerritory(tx: any, companyId: string | null | undefined, value: unknown): Promise<string | null> {
  const name = String(value ?? '').trim();
  if (!name) return null;
  const row = await tx.crmTerritory.findFirst({ where: { companyId: companyId || undefined, name: { equals: name, mode: 'insensitive' }, isActive: true } });
  if (!row) throw new Error(`Unknown territory: ${name}. Add it under CRM Configuration first.`);
  return row.name;
}

export function normalizeEmail(email?: string | null) {
  return String(email || '').normalize('NFKC').trim().toLowerCase() || null;
}

export function normalizePhone(phone?: string | null, country?: string | null) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const code = String(country || '').trim().toUpperCase();
  if ((code === 'IN' || code === 'IND' || code === 'INDIA') && digits.length === 10) digits = `91${digits}`;
  if ((code === 'IN' || code === 'IND' || code === 'INDIA') && digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  return digits ? `+${digits}` : null;
}

export function titleFromLead(row: any) {
  return row.title || [row.firstName, row.lastName, row.company].filter(Boolean).join(' - ') || 'Untitled lead';
}

export function parseCsv(text: string) {
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }
  row.push(current.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function csvToObjects(text: string) {
  const rows = parseCsv(text);
  const headers = (rows.shift() || []).map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));
  return rows.map((values, index) => {
    const raw: any = {};
    headers.forEach((header, i) => { raw[header] = values[i] || ''; });
    return { rowNo: index + 2, raw };
  });
}

export function normalizeLeadRow(raw: any) {
  const firstName = raw.firstName || raw.firstname || raw.first || raw.name?.split(' ')?.[0] || '';
  const lastName = raw.lastName || raw.lastname || raw.last || raw.name?.split(' ')?.slice(1).join(' ') || '';
  const email = normalizeEmail(raw.email);
  const { phones: phoneList, error: phoneError } = parsePhones(raw, raw.country);
  const mainPhone = primaryPhone(phoneList);
  const phone = mainPhone ? normalizePhone(mainPhone.number, raw.country) : null;
  const status = normalizeLeadStatus(raw.status);
  return {
    title: raw.title || [firstName, lastName, raw.company].filter(Boolean).join(' - '),
    firstName,
    lastName,
    email,
    phone,
    // Not a Lead column: callers must take it out before the object goes into prisma.lead.create.
    phoneList,
    phoneError,
    company: raw.company || raw.organization || '',
    jobTitle: String(raw.jobTitle || raw.jobtitle || raw.job_title || raw['job title'] || raw.designation || '').trim() || undefined,
    city: raw.city || '',
    country: raw.country || '',
    source: raw.source || 'CSV_IMPORT',
    status: status === undefined ? 'LEAD' : status,
    priority: raw.priority || 'MEDIUM',
    value: raw.value ? Number(raw.value) : undefined,
    notes: raw.notes || raw.note || '',
    territory: raw.territory ? String(raw.territory).trim() : undefined,
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean)
      : raw.tags ? String(raw.tags).split(/[|;,]/).map((t) => t.trim()).filter(Boolean) : [],
  };
}

export function validateLead(row: any) {
  if (!row.firstName && !row.lastName && !row.company) return 'Provide a name or company';
  if (row.status === null) return 'Invalid lead status';
  if (row.phoneError) return row.phoneError;
  if (!row.email && !row.phone) return 'Provide email or phone';
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return 'Invalid email';
  return null;
}

export async function findDuplicateLead(tx: any, row: any) {
  const OR = [];
  if (row.email) OR.push({ normalizedEmail: normalizeEmail(row.email) });
  const numbers = new Set<string>();
  for (const phone of row.phoneList || []) numbers.add(phone.normalized);
  if (row.phone) numbers.add(String(row.phone).replace(/\D/g, ''));
  if (numbers.size) {
    // The primary number is mirrored on Lead.normalizedPhone; every other number lives in CrmPhone.
    OR.push({ normalizedPhone: { in: [...numbers] } });
    OR.push({ phones: { some: { normalized: { in: [...numbers] } } } });
  }
  if (!OR.length) return null;
  return tx.lead.findFirst({ where: { OR, mergedIntoId: null, status: { notIn: CLOSED_LEAD_STATUSES as any }, ...(row.companyId ? { companyId: row.companyId } : {}) }, select: { id: true, title: true, email: true, phone: true } });
}

// The contact record of a person who is already in the CRM (same email or phone number), so converting a
// returning person's new lead reuses their contact instead of creating a second one.
export async function findExistingContact(tx: any, lead: any) {
  const email = normalizeEmail(lead.email);
  const numbers = (lead.phones || []).map((phone: any) => phone.normalized).filter(Boolean);
  const OR: any[] = [];
  if (email) OR.push({ email: { equals: email, mode: 'insensitive' } });
  if (numbers.length) OR.push({ phones: { some: { normalized: { in: numbers } } } });
  if (!OR.length) return null;
  return tx.contact.findFirst({ where: { OR, isActive: true }, orderBy: { createdAt: 'asc' } });
}

export async function ensureOrganization(tx: any, row: any, companyId?: string | null, ownerId?: string | null) {
  const name = String(row.company || row.organizationName || '').trim();
  if (!name) return null;
  const existing = await tx.crmOrganization.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, companyId: companyId || undefined } });
  if (existing) return existing;
  const created = await tx.crmOrganization.create({ data: { name, companyId, ownerId, email: row.email, phone: row.phone, city: row.city, country: row.country, territory: row.territory || undefined } });
  if (row.phoneList?.length) await addMissingPhones(tx, { organizationId: created.id }, companyId, row.phoneList);
  return created;
}

function normalizedMatch(value?: string | null, expected?: string | null) {
  if (!expected) return true;
  return String(value || '').trim().toLowerCase() === String(expected).trim().toLowerCase();
}

export async function resolveLeadAssignee(tx: any, row: any, companyId?: string | null, fallbackUserId?: string | null) {
  const rules = await tx.crmAssignmentRule.findMany({
    where: {
      isActive: true,
      OR: [{ companyId: companyId || undefined }, { companyId: null }],
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  const value = row.value === undefined || row.value === null || row.value === '' ? null : Number(row.value);
  const match = rules.find((rule: any) => {
    if (rule.source && rule.source !== row.source) return false;
    if (!normalizedMatch(row.city, rule.city)) return false;
    if (!normalizedMatch(row.country, rule.country)) return false;
    if (!normalizedMatch(row.territory, rule.territory)) return false;
    if (rule.branchId && rule.branchId !== row.branchId) return false;
    if (rule.productId && rule.productId !== row.productId && rule.productId !== row.productInterest) return false;
    if (rule.minValue !== null && value !== null && value < Number(rule.minValue)) return false;
    if (rule.minValue !== null && value === null) return false;
    if (rule.maxValue !== null && value !== null && value > Number(rule.maxValue)) return false;
    if (rule.maxValue !== null && value === null) return false;
    return true;
  });
  if (match?.assignToId) return match.assignToId;
  const queue = companyId ? await tx.platformSetting.findFirst({ where: { companyId, namespace: 'crm', key: 'defaultQueueUserId' }, orderBy: { updatedAt: 'desc' } }) : null;
  return (typeof queue?.value === 'string' ? queue.value : null) || fallbackUserId || null;
}

export async function logCrmActivity(tx: any, userId: string, data: any) {
  return tx.activity.create({
    data: {
      type: data.type,
      subject: data.subject,
      description: data.description,
      status: data.status || 'COMPLETED',
      completedAt: data.completedAt || new Date(),
      metadata: data.metadata,
      organizationId: data.organizationId,
      leadId: data.leadId,
      contactId: data.contactId,
      opportunityId: data.opportunityId,
      userId,
    },
  });
}

export function calculateOpportunityItems(items: any[] = []) {
  let total = new Prisma.Decimal(0);
  const lines = items.map((item) => {
    const quantity = new Prisma.Decimal(item.quantity || 1);
    const rate = new Prisma.Decimal(item.rate || item.unitPrice || 0);
    const discount = new Prisma.Decimal(item.discount || 0);
    const taxRate = new Prisma.Decimal(item.taxRate || 0);
    const net = quantity.mul(rate).mul(new Prisma.Decimal(1).minus(discount.div(100)));
    const amount = net.plus(net.mul(taxRate.div(100)));
    total = total.plus(amount);
    return {
      productId: item.productId || undefined,
      itemCode: item.itemCode || undefined,
      description: item.description || item.name || 'Opportunity item',
      quantity,
      rate,
      discount,
      taxRate,
      amount,
    };
  });
  return { lines, total: Number(total.toFixed(2)) };
}
