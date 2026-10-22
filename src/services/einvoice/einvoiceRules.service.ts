// Pure e-invoice rules: no database, no clock except where a `now` is passed in. Every statutory number
// (turnover threshold, reporting window, cancel window, warning points, max document number length) comes
// from an effective-dated EInvoiceRuleVersion row, never from a constant in this file.
// All statutory values must be verified by the CA before release (see docs/einvoice-implementation-plan.md).
// Checked against: NIC e-invoice sandbox validations (document number, date, export codes, round-off, tolerances),
// GSTN advisory of 5 Nov 2024 (30-day reporting for AATO of 10 crore and above, from 1 Apr 2025), CBIC Notification
// 10/2023 (5 crore applicability threshold from 1 Aug 2023) and the GSTN advisory of 17 Jun 2026 (ship-to GSTIN from 1 Aug 2026).
import { GSTIN_PATTERN, PINCODE_PATTERN, STATE_CODES, isValidGstin, normalizeGstin, stateCodeOfGstin } from '../eway/ewayRules.service';

export { GSTIN_PATTERN, PINCODE_PATTERN, STATE_CODES, isValidGstin, normalizeGstin, stateCodeOfGstin };

export type EInvoiceDocType = 'INV' | 'CRN' | 'DBN';
export const EINVOICE_DOC_TYPES: EInvoiceDocType[] = ['INV', 'CRN', 'DBN'];

export type RuleVersion = {
  id?: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  turnoverThreshold: number;
  reportingWindowDays: number;
  reportingWindowTurnoverFloor?: number | null;
  warnAtPercents: number[];
  cancelWindowHours: number;
  maxDocNoLength: number;
  shipToGstinMandatoryFrom?: Date | null;
  schemaVersion?: string | null;
  verifiedByCa?: boolean;
};

// Prefill for creating a rule version. It is NOT read when deciding anything, and a row created from it
// stays unverified until the CA signs it off. Re-check every value against the current GSTN/NIC notices.
export const RULE_VERSION_TEMPLATE = {
  // E-invoicing applies when aggregate turnover in any earlier financial year (from 2017-18) exceeded 5 crore.
  turnoverThreshold: 50000000,
  // The 30-day reporting limit applies to taxpayers with aggregate turnover of 10 crore and above.
  reportingWindowDays: 30,
  reportingWindowTurnoverFloor: 100000000,
  warnAtPercents: [50, 80],
  cancelWindowHours: 24,
  maxDocNoLength: 16,
  shipToGstinMandatoryFrom: '2026-08-01',
  schemaVersion: '1.1',
} as const;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// ---- financial year and rule lookup -------------------------------------------------------------------

// "2026-27" for a document dated between 1 Apr 2026 and 31 Mar 2027, using the company's fiscal-year start month
// (April by default). Dates are read in UTC like the rest of the numbering code.
export function financialYearOf(date: Date, fiscalYearStartMonth = 4) {
  const month = date.getUTCMonth() + 1;
  const start = month >= fiscalYearStartMonth ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

export function financialYearStartYear(financialYear: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(financialYear);
  if (!match) throw new Error(`Invalid financial year "${financialYear}"`);
  return Number(match[1]);
}

// The version in force on `onDate`: latest effectiveFrom on or before the date, and not already ended.
export function pickRuleVersion<T extends Pick<RuleVersion, 'effectiveFrom' | 'effectiveTo'>>(versions: T[], onDate: Date): T | null {
  const time = onDate.getTime();
  const candidates = versions
    .filter((version) => version.effectiveFrom.getTime() <= time && (!version.effectiveTo || version.effectiveTo.getTime() >= time))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return candidates[0] || null;
}

// ---- validators ---------------------------------------------------------------------------------------

// The IRP accepts letters, digits, "/" and "-", starting with a letter or non-zero digit, up to 16 characters.
// The length comes from the rule version. (confirm the character rule against the current IRP schema)
export function validateDocNo(docNo: string | null | undefined, maxLength = 16): string | null {
  const value = String(docNo || '');
  if (!value) return 'Document number is empty';
  if (value.length > maxLength) return `Document number "${value}" is longer than ${maxLength} characters`;
  if (!/^[A-Za-z1-9][A-Za-z0-9/-]*$/.test(value)) return `Document number "${value}" may only use letters, digits, "/" and "-", and cannot start with 0`;
  return null;
}

export function panFromGstin(gstin?: string | null) {
  const value = normalizeGstin(gstin);
  return GSTIN_PATTERN.test(value) ? value.slice(2, 12) : null;
}

// Ship-to GSTIN is optional unless the rule version makes it mandatory from a date. When present it must be a
// valid GSTIN. Returns an error message or null.
export function validateShipToGstin(input: { shipToGstin?: string | null; docDate: Date; rule?: Pick<RuleVersion, 'shipToGstinMandatoryFrom'> | null; hasShipToParty: boolean }): string | null {
  const gstin = normalizeGstin(input.shipToGstin);
  // URP is allowed for a consignee that is not registered.
  if (gstin) return gstin === 'URP' || isValidGstin(gstin) ? null : `Ship-to GSTIN "${gstin}" is not a valid GSTIN (use URP for an unregistered consignee)`;
  const from = input.rule?.shipToGstinMandatoryFrom;
  if (input.hasShipToParty && from && input.docDate.getTime() >= from.getTime()) return 'Ship-to GSTIN is mandatory for this document date';
  return null;
}

// ---- applicability --------------------------------------------------------------------------------------

export type OverrideMode = 'NONE' | 'FORCE_ON' | 'FORCE_OFF';
export type ApplicabilityCode =
  | 'REQUIRED_TURNOVER' | 'REQUIRED_OVERRIDE'
  | 'DOC_TYPE_NOT_ELIGIBLE' | 'NO_BUYER_GSTIN' | 'EXEMPT' | 'BELOW_THRESHOLD' | 'NO_RULE_VERSION' | 'NO_SUPPLIER_GSTIN'
  | 'OVERRIDE_OFF';
export type ApplicabilityResult = {
  status: 'REQUIRED' | 'NOT_APPLICABLE' | 'SKIPPED';
  code: ApplicabilityCode;
  reason: string;
  // Needs a person: the rule or the data is missing, so "not applicable" is a guess, not a decision.
  needsAttention: boolean;
  warnings: string[];
  threshold?: number;
  turnover?: number;
};

export type ApplicabilityInput = {
  docType: string;
  supplierGstin?: string | null;
  buyerGstin?: string | null;
  exportOrSez?: boolean; // export and SEZ are eligible without a buyer GSTIN
  companyExempt?: boolean;
  branchExempt?: boolean;
  overrideMode?: OverrideMode;
  overrideReason?: string | null;
  aggregateTurnover?: number | null; // see relevantTurnover()
  rule?: Pick<RuleVersion, 'turnoverThreshold'> | null;
};

// Decides, for one document, whether it must be registered. Order matters:
// 1 document eligibility (nothing to register for a challan or an unregistered buyer), 2 supplier GSTIN,
// 3 manual override, 4 exemption, 5 rule version present, 6 turnover against the threshold.
export function evaluateApplicability(input: ApplicabilityInput): ApplicabilityResult {
  const warnings: string[] = [];
  const buyer = normalizeGstin(input.buyerGstin);
  const base = { warnings, needsAttention: false };

  if (!EINVOICE_DOC_TYPES.includes(String(input.docType).toUpperCase() as EInvoiceDocType)) {
    return { ...base, status: 'NOT_APPLICABLE', code: 'DOC_TYPE_NOT_ELIGIBLE', reason: `${input.docType} documents are not reported as e-invoices` };
  }
  if (!buyer && !input.exportOrSez) {
    return { ...base, status: 'NOT_APPLICABLE', code: 'NO_BUYER_GSTIN', reason: 'Buyer has no GSTIN (B2C), so there is nothing to report' };
  }
  if (buyer && !isValidGstin(buyer)) warnings.push(`Buyer GSTIN "${buyer}" is not valid: the portal will reject this document until it is corrected`);
  if (!isValidGstin(input.supplierGstin)) {
    return { ...base, needsAttention: true, status: 'NOT_APPLICABLE', code: 'NO_SUPPLIER_GSTIN', reason: 'Supplier GSTIN is missing or invalid, so applicability cannot be decided' };
  }

  const override = input.overrideMode || 'NONE';
  if (override === 'FORCE_OFF') return { ...base, status: 'SKIPPED', code: 'OVERRIDE_OFF', reason: `Manual override: not reported${input.overrideReason ? ` (${input.overrideReason})` : ''}` };
  if (override === 'FORCE_ON') return { ...base, status: 'REQUIRED', code: 'REQUIRED_OVERRIDE', reason: `Manual override: reported${input.overrideReason ? ` (${input.overrideReason})` : ''}` };

  if (input.companyExempt || input.branchExempt) return { ...base, status: 'NOT_APPLICABLE', code: 'EXEMPT', reason: 'Supplier is marked exempt from e-invoicing' };
  if (!input.rule) return { ...base, needsAttention: true, status: 'NOT_APPLICABLE', code: 'NO_RULE_VERSION', reason: 'No e-invoice rule version is configured for this document date' };

  const threshold = Number(input.rule.turnoverThreshold);
  const turnover = Number(input.aggregateTurnover ?? 0);
  if (turnover > threshold) return { ...base, status: 'REQUIRED', code: 'REQUIRED_TURNOVER', reason: 'Aggregate turnover is above the e-invoice threshold', threshold, turnover };
  return { ...base, status: 'NOT_APPLICABLE', code: 'BELOW_THRESHOLD', reason: 'Aggregate turnover is not above the e-invoice threshold', threshold, turnover };
}

// A PAN is covered when its turnover in ANY EARLIER financial year exceeded the threshold; crossing it during the
// current year only starts the obligation from the next year. So the figure to test is the largest one declared for
// a year before the document's own year.
export function relevantTurnover(rows: Array<{ financialYear: string; aggregateTurnover: number | string | { toString(): string } }>, financialYear: string) {
  const current = financialYearStartYear(financialYear);
  let max = 0;
  for (const row of rows) {
    if (financialYearStartYear(row.financialYear) >= current) continue;
    max = Math.max(max, Number(row.aggregateTurnover.toString()));
  }
  return max;
}

// ---- reporting window -----------------------------------------------------------------------------------

const IST_MS = 5.5 * HOUR_MS;

// The instant the reporting window closes. Days are counted from the document date as day 1 in Indian time, so a
// 30-day window on an invoice dated 1 April lets it be reported through 30 April and closes at midnight into 1 May.
// Null when the rule version sets no window, or when the supplier's turnover is below the floor at which the portal
// enforces one.
export function reportingDeadline(docDate: Date, rule: Pick<RuleVersion, 'reportingWindowDays' | 'reportingWindowTurnoverFloor'>, turnover: number): Date | null {
  if (!rule.reportingWindowDays || rule.reportingWindowDays <= 0) return null;
  if (rule.reportingWindowTurnoverFloor != null && turnover < Number(rule.reportingWindowTurnoverFloor)) return null;
  const istMidnight = Math.floor((docDate.getTime() + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
  return new Date(istMidnight + rule.reportingWindowDays * DAY_MS);
}

export type WindowState = { percentUsed: number; crossed: number[]; breached: boolean; msLeft: number };

// How much of the window has gone, and which warning points (e.g. 50, 80) have been passed.
export function windowProgress(now: Date, docDate: Date, deadline: Date, warnAtPercents: number[]): WindowState {
  const total = deadline.getTime() - docDate.getTime();
  const used = now.getTime() - docDate.getTime();
  const percentUsed = total <= 0 ? 100 : Math.max(0, (used / total) * 100);
  return {
    percentUsed,
    crossed: [...warnAtPercents].sort((a, b) => a - b).filter((point) => percentUsed >= point),
    breached: now.getTime() > deadline.getTime(),
    msLeft: deadline.getTime() - now.getTime(),
  };
}

// ---- cancellation window --------------------------------------------------------------------------------

export function cancelDeadline(ackDate: Date, rule: Pick<RuleVersion, 'cancelWindowHours'>) {
  return new Date(ackDate.getTime() + rule.cancelWindowHours * HOUR_MS);
}

export type CancelState = { canCancel: boolean; deadline: Date; secondsLeft: number; reasonIfNot: string | null };

// Portal cancellation is only possible inside the window. After it, the only correction is a credit note.
export function cancelState(now: Date, ackDate: Date, rule: Pick<RuleVersion, 'cancelWindowHours'>): CancelState {
  const deadline = cancelDeadline(ackDate, rule);
  const secondsLeft = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));
  const canCancel = now.getTime() <= deadline.getTime();
  return { canCancel, deadline, secondsLeft, reasonIfNot: canCancel ? null : `The ${rule.cancelWindowHours}-hour cancellation window has passed. Issue a credit note instead.` };
}

// Portal cancel reason codes. (confirm against the current IRP documentation)
export const CANCEL_REASON_CODES: Record<string, string> = { '1': 'Duplicate', '2': 'Data entry mistake', '3': 'Order cancelled', '4': 'Others' };
