// Database side of the e-invoice settings: config, rule versions, PAN turnover, and the per-document
// "is an e-invoice required" decision. `tx` is a Prisma client or transaction; the tenant layer scopes every
// query to the current company.
import { audit } from '../../utils/erp';
import { currentCompanyId } from '../../utils/tenant';
import {
  PINCODE_PATTERN, RULE_VERSION_TEMPLATE, STATE_CODES, evaluateApplicability, financialYearOf, financialYearStartYear, isValidGstin, normalizeGstin, panFromGstin, pickRuleVersion,
  relevantTurnover, stateCodeOfGstin, type ApplicabilityResult, type RuleVersion,
} from './einvoiceRules.service';

export class EInvoiceError extends Error {
  constructor(message: string, public status = 400, public details?: string[]) { super(message); }
}

const num = (value: any) => (value == null ? value : Number(value.toString()));

export function toRuleVersion(row: any): RuleVersion & { id: string } {
  return {
    id: row.id,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    turnoverThreshold: num(row.turnoverThreshold),
    reportingWindowDays: row.reportingWindowDays,
    reportingWindowTurnoverFloor: num(row.reportingWindowTurnoverFloor),
    warnAtPercents: row.warnAtPercents || [],
    cancelWindowHours: row.cancelWindowHours,
    maxDocNoLength: row.maxDocNoLength,
    shipToGstinMandatoryFrom: row.shipToGstinMandatoryFrom,
    schemaVersion: row.schemaVersion,
    verifiedByCa: row.verifiedByCa,
  };
}

// ---- config ---------------------------------------------------------------------------------------------

export async function getConfig(tx: any) {
  const existing = await tx.eInvoiceConfig.findFirst({});
  if (existing) return existing;
  return tx.eInvoiceConfig.create({ data: { companyId: currentCompanyId() } });
}

export async function updateConfig(tx: any, req: any, input: any) {
  const current = await getConfig(tx);
  const data: any = {};
  // Only MANUAL exists until a GSP integration is built; API mode is rejected rather than silently ignored.
  if (input.mode !== undefined && input.mode !== 'MANUAL') throw new EInvoiceError('Only MANUAL mode is available; API mode needs a GSP integration');
  if (input.hardBlockOnSubmit !== undefined) data.hardBlockOnSubmit = Boolean(input.hardBlockOnSubmit);
  if (input.followUpDays !== undefined) {
    const days = Number(input.followUpDays);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new EInvoiceError('Follow-up days must be a whole number from 1 to 60');
    data.followUpDays = days;
  }
  if (input.overrideMode !== undefined) {
    if (!['NONE', 'FORCE_ON', 'FORCE_OFF'].includes(input.overrideMode)) throw new EInvoiceError('overrideMode must be NONE, FORCE_ON or FORCE_OFF');
    if (input.overrideMode !== 'NONE' && !String(input.overrideReason || '').trim()) throw new EInvoiceError('A reason is required for a manual override');
    data.overrideMode = input.overrideMode;
    data.overrideReason = input.overrideMode === 'NONE' ? null : String(input.overrideReason).trim();
    data.overrideById = input.overrideMode === 'NONE' ? null : req.user?.id ?? null;
    data.overrideAt = input.overrideMode === 'NONE' ? null : new Date();
  }
  const updated = await tx.eInvoiceConfig.update({ where: { id: current.id }, data });
  await audit(tx, req, { entityType: 'EINVOICE_CONFIG', entityId: updated.id, action: 'UPDATE', message: `Updated e-invoice settings${data.overrideMode ? ` (override ${data.overrideMode})` : ''}` });
  return updated;
}

// ---- rule versions --------------------------------------------------------------------------------------

export async function listRuleVersions(tx: any) {
  return tx.eInvoiceRuleVersion.findMany({ orderBy: { effectiveFrom: 'desc' } });
}

// The version in force on a date, or null when none is configured (callers must treat that as "needs attention").
export async function ruleVersionFor(tx: any, onDate: Date) {
  const rows = await tx.eInvoiceRuleVersion.findMany({ where: { effectiveFrom: { lte: onDate } }, orderBy: { effectiveFrom: 'desc' }, take: 20 });
  return pickRuleVersion(rows.map(toRuleVersion), onDate) as (RuleVersion & { id: string }) | null;
}

function validateRuleInput(input: any) {
  const errors: string[] = [];
  const positive = (value: any) => value != null && Number.isFinite(Number(value)) && Number(value) > 0;
  if (!positive(input.turnoverThreshold)) errors.push('turnoverThreshold must be a positive number');
  if (!Number.isInteger(Number(input.reportingWindowDays)) || Number(input.reportingWindowDays) < 0) errors.push('reportingWindowDays must be a whole number of days (0 for no window)');
  if (!Number.isInteger(Number(input.cancelWindowHours)) || Number(input.cancelWindowHours) <= 0) errors.push('cancelWindowHours must be a positive whole number');
  const warn = input.warnAtPercents ?? [50, 80];
  if (!Array.isArray(warn) || warn.some((point: any) => !Number.isFinite(Number(point)) || Number(point) <= 0 || Number(point) >= 100)) errors.push('warnAtPercents must be numbers between 0 and 100');
  if (Number.isNaN(new Date(input.effectiveFrom).getTime())) errors.push('effectiveFrom must be a valid date');
  return errors;
}

// Adds a rule version. Versions are never edited: a rule change is a new row with a later effectiveFrom, and the
// open version is closed the moment before it, so every past document stays explainable by the rule of its date.
export async function createRuleVersion(tx: any, req: any, input: any) {
  const errors = validateRuleInput(input);
  if (errors.length) throw new EInvoiceError(errors.join('; '));
  const effectiveFrom = new Date(input.effectiveFrom);
  const latest = await tx.eInvoiceRuleVersion.findFirst({ orderBy: { effectiveFrom: 'desc' } });
  if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
    throw new EInvoiceError(`A rule version already starts on or after ${latest.effectiveFrom.toISOString().slice(0, 10)}. Add the new version with a later effective date.`, 409);
  }
  if (latest && (!latest.effectiveTo || latest.effectiveTo.getTime() >= effectiveFrom.getTime())) {
    await tx.eInvoiceRuleVersion.update({ where: { id: latest.id }, data: { effectiveTo: new Date(effectiveFrom.getTime() - 1) } });
  }
  const created = await tx.eInvoiceRuleVersion.create({
    data: {
      effectiveFrom,
      turnoverThreshold: input.turnoverThreshold,
      reportingWindowDays: Number(input.reportingWindowDays),
      reportingWindowTurnoverFloor: input.reportingWindowTurnoverFloor ?? null,
      warnAtPercents: (input.warnAtPercents ?? [...RULE_VERSION_TEMPLATE.warnAtPercents]).map(Number),
      cancelWindowHours: Number(input.cancelWindowHours),
      maxDocNoLength: Number(input.maxDocNoLength ?? RULE_VERSION_TEMPLATE.maxDocNoLength),
      shipToGstinMandatoryFrom: input.shipToGstinMandatoryFrom ? new Date(input.shipToGstinMandatoryFrom) : null,
      schemaVersion: input.schemaVersion ?? null,
      notes: input.notes ?? null,
      createdById: req.user?.id,
    },
  });
  await audit(tx, req, { entityType: 'EINVOICE_RULE_VERSION', entityId: created.id, action: 'CREATE', message: `Added e-invoice rule version effective ${effectiveFrom.toISOString().slice(0, 10)}` });
  return created;
}

// CA sign-off is the only change allowed on a version after it is created.
export async function verifyRuleVersion(tx: any, req: any, id: string, input: { caName?: string; caReference?: string }) {
  if (!String(input.caName || '').trim()) throw new EInvoiceError('CA name is required to verify a rule version');
  const result = await tx.eInvoiceRuleVersion.updateMany({ where: { id }, data: { verifiedByCa: true, caName: String(input.caName).trim(), caReference: input.caReference ?? null, caVerifiedAt: new Date() } });
  if (!result.count) throw new EInvoiceError('Rule version not found', 404);
  await audit(tx, req, { entityType: 'EINVOICE_RULE_VERSION', entityId: id, action: 'VERIFY', message: `CA ${String(input.caName).trim()} verified the rule version` });
  return tx.eInvoiceRuleVersion.findFirst({ where: { id } });
}

// ---- turnover -------------------------------------------------------------------------------------------

export async function listTurnover(tx: any) {
  return tx.eInvoiceTurnover.findMany({ orderBy: [{ pan: 'asc' }, { financialYear: 'desc' }] });
}

export async function setTurnover(tx: any, req: any, input: { pan: string; financialYear: string; aggregateTurnover: number; notes?: string }) {
  const pan = String(input.pan || '').trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw new EInvoiceError('PAN is not valid');
  if (!/^\d{4}-\d{2}$/.test(input.financialYear)) throw new EInvoiceError('financialYear must look like 2026-27');
  if (!Number.isFinite(Number(input.aggregateTurnover)) || Number(input.aggregateTurnover) < 0) throw new EInvoiceError('aggregateTurnover must be zero or more');
  const where = { pan, financialYear: input.financialYear };
  const existing = await tx.eInvoiceTurnover.findFirst({ where });
  const data = { aggregateTurnover: input.aggregateTurnover, notes: input.notes ?? null, updatedById: req.user?.id ?? null };
  const row = existing ? await tx.eInvoiceTurnover.update({ where: { id: existing.id }, data }) : await tx.eInvoiceTurnover.create({ data: { ...where, ...data } });
  await audit(tx, req, { entityType: 'EINVOICE_TURNOVER', entityId: row.id, action: existing ? 'UPDATE' : 'CREATE', message: `Turnover for ${pan} ${input.financialYear}: ${input.aggregateTurnover}` });
  return row;
}

// ---- applicability --------------------------------------------------------------------------------------

export type DocumentForApplicability = {
  docType: string;
  docDate: Date;
  supplierGstin?: string | null;
  buyerGstin?: string | null;
  exportOrSez?: boolean;
  companyExempt?: boolean;
  branchExempt?: boolean;
  fiscalYearStartMonth?: number;
};

export type Applicability = ApplicabilityResult & { ruleVersionId: string | null; financialYear: string; rule: (RuleVersion & { id: string }) | null; turnover: number };

// Everything needed to decide whether a document must be registered. Reads the rule version for the document date,
// the PAN's declared turnover and the company override; the decision itself is pure.
export async function evaluateForDocument(tx: any, doc: DocumentForApplicability): Promise<Applicability> {
  const financialYear = financialYearOf(doc.docDate, doc.fiscalYearStartMonth || 4);
  const [rule, config] = await Promise.all([ruleVersionFor(tx, doc.docDate), getConfig(tx)]);
  const pan = panFromGstin(doc.supplierGstin);
  const rows = pan ? await tx.eInvoiceTurnover.findMany({ where: { pan } }) : [];
  const turnover = relevantTurnover(rows, financialYear);
  const result = evaluateApplicability({
    docType: doc.docType,
    supplierGstin: normalizeGstin(doc.supplierGstin),
    buyerGstin: doc.buyerGstin,
    exportOrSez: doc.exportOrSez,
    companyExempt: doc.companyExempt,
    branchExempt: doc.branchExempt,
    overrideMode: config.overrideMode,
    overrideReason: config.overrideReason,
    aggregateTurnover: turnover,
    rule,
  });
  if (rule && !rule.verifiedByCa) result.warnings.push('The rule version in force has not been verified by the CA');
  return { ...result, ruleVersionId: rule?.id ?? null, financialYear, rule, turnover };
}

// ---- company GST details and setup checklist ------------------------------------------------------------------------

const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;
const PROFILE_FIELDS = ['legalName', 'gstin', 'pan', 'address', 'city', 'state', 'zip', 'einvoiceExempt', 'fiscalYearStart'] as const;

async function loadCompany(tx: any) {
  const companyId = currentCompanyId();
  const company = companyId ? await tx.company.findUnique({ where: { id: companyId } }) : await tx.company.findFirst({});
  if (!company) throw new EInvoiceError('Company not found', 404);
  return company;
}

export async function getCompanyProfile(tx: any) {
  const company = await loadCompany(tx);
  return { id: company.id, name: company.name, ...Object.fromEntries(PROFILE_FIELDS.map((key) => [key, company[key] ?? (key === 'einvoiceExempt' ? false : null)])) };
}

// The seller details the e-invoice needs: legal name, GSTIN, PAN, address, city, pincode. Entered once here so nobody has
// to edit the database. A valid GSTIN fixes the state, and its PAN part must agree with the PAN.
export async function updateCompanyProfile(tx: any, req: any, input: any) {
  const company = await loadCompany(tx);
  const data: any = {};
  const text = (key: string) => (input[key] === undefined ? undefined : String(input[key] ?? '').trim());
  const errors: string[] = [];

  const legalName = text('legalName');
  if (legalName !== undefined) { if (legalName && legalName.length < 3) errors.push('Legal name must be at least 3 characters'); data.legalName = legalName || null; }
  for (const key of ['address', 'city'] as const) { const value = text(key); if (value !== undefined) data[key] = value || null; }
  const zip = text('zip');
  if (zip !== undefined) { if (zip && !PINCODE_PATTERN.test(zip)) errors.push('Pincode must be 6 digits'); data.zip = zip || null; }
  if (input.einvoiceExempt !== undefined) data.einvoiceExempt = Boolean(input.einvoiceExempt);

  let gstin = input.gstin === undefined ? normalizeGstin(company.gstin) : normalizeGstin(input.gstin);
  if (input.gstin !== undefined) {
    if (gstin && !isValidGstin(gstin)) errors.push(`GSTIN "${gstin}" is not a valid GSTIN`);
    data.gstin = gstin || null;
  }
  let pan = input.pan === undefined ? String(company.pan || '').toUpperCase() : String(input.pan || '').trim().toUpperCase();
  if (input.pan !== undefined && pan && !PAN_PATTERN.test(pan)) errors.push(`PAN "${pan}" is not a valid PAN`);
  if (isValidGstin(gstin)) {
    const fromGstin = panFromGstin(gstin)!;
    if (!pan) pan = fromGstin;
    else if (PAN_PATTERN.test(pan) && pan !== fromGstin) errors.push(`PAN ${pan} does not match the PAN inside the GSTIN (${fromGstin})`);
    // the state follows the GSTIN
    data.state = STATE_CODES[stateCodeOfGstin(gstin)!] || company.state;
  } else if (input.state !== undefined) data.state = String(input.state || '').trim() || null;
  if (input.pan !== undefined || isValidGstin(gstin)) data.pan = pan || null;
  if (input.fiscalYearStart !== undefined) {
    const month = Number(input.fiscalYearStart);
    if (!Number.isInteger(month) || month < 1 || month > 12) errors.push('Financial year start must be a month from 1 to 12');
    else data.fiscalYearStart = month;
  }
  if (errors.length) throw new EInvoiceError(errors.join('; '));
  await tx.company.update({ where: { id: company.id }, data });
  await audit(tx, req, { entityType: 'COMPANY_GST_PROFILE', entityId: company.id, action: 'UPDATE', message: `Updated company GST details${data.gstin !== undefined ? ` (GSTIN ${data.gstin || 'cleared'})` : ''}` });
  return getCompanyProfile(tx);
}

export type ReadinessItem = { key: string; label: string; ok: boolean; message: string };

// What is still missing before an e-invoice can be prepared and judged: shown as a checklist on the E-Invoices page.
export async function readiness(tx: any, now: Date = new Date()): Promise<{ ready: boolean; items: ReadinessItem[]; pan: string | null; previousFinancialYear: string }> {
  const company = await loadCompany(tx);
  const gstin = normalizeGstin(company.gstin);
  const pan = panFromGstin(gstin) || (PAN_PATTERN.test(String(company.pan || '').toUpperCase()) ? String(company.pan).toUpperCase() : null);
  const financialYear = financialYearOf(now, company.fiscalYearStart || 4);
  const previousStart = financialYearStartYear(financialYear) - 1;
  const previousFinancialYear = `${previousStart}-${String(previousStart + 1).slice(-2)}`;
  const items: ReadinessItem[] = [];
  const add = (key: string, label: string, ok: boolean, good: string, bad: string) => items.push({ key, label, ok, message: ok ? good : bad });

  add('gstin', 'Company GSTIN', isValidGstin(gstin), `GSTIN ${gstin}`, 'Enter the company GSTIN below');
  const nameOk = String(company.legalName || '').trim().length >= 3;
  const addressOk = !!String(company.address || '').trim() && String(company.city || '').trim().length >= 3 && PINCODE_PATTERN.test(String(company.zip || '').trim());
  add('seller', 'Legal name, address, city and pincode', nameOk && addressOk, 'Seller details are complete', 'The portal needs the legal name, address, a city of at least 3 letters, and a 6-digit pincode');
  const rule = await ruleVersionFor(tx, now);
  add('rule', 'E-invoice rule version in force', !!rule, 'A rule version is in force today', 'No rule version is in force. Add one under the Settings tab, then ask the CA to verify it');
  add('ca', 'Rule version verified by the CA', !!rule?.verifiedByCa, 'Verified by the CA', rule ? 'The CA has not verified the rule version yet' : 'Needs a rule version first');
  const rows = pan ? await tx.eInvoiceTurnover.findMany({ where: { pan } }) : [];
  const declared = rows.some((row: any) => financialYearStartYear(row.financialYear) < financialYearStartYear(financialYear));
  add('turnover', `Turnover of an earlier year (such as ${previousFinancialYear})`, declared, 'Turnover is declared', `Declare the turnover of ${previousFinancialYear} (or an earlier year): the current year does not count`);
  return { ready: items.every((item) => item.ok), items, pan, previousFinancialYear };
}
