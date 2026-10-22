// Reading what the e-invoice portal returns. Pure functions, no database.
// Verified against the NIC sandbox sample response: { Status, Data: { AckNo, AckDt "yyyy-mm-dd hh:mm:ss", Irn, SignedInvoice,
// SignedQRCode, Status "ACT" }, ErrorDetails: [{ ErrorCode, ErrorMessage }] }, where SignedInvoice and SignedQRCode are signed
// tokens whose payload `data` holds the invoice (SellerDtls, DocDtls, ValDtls, Irn) and the QR fields (SellerGstin, DocNo,
// DocTyp, DocDt, TotInvVal, Irn, IrnDt). The layout of the BULK upload result file is not published, so rows are read
// tolerantly (field names in any case; a list, a data key, or the single-response shape above).
import { isValidGstin, normalizeGstin } from './einvoiceRules.service';

export const IRN_PATTERN = /^[0-9a-fA-F]{64}$/;

export type SignedInvoiceInfo = { irn?: string; irnDate?: string; docNo?: string; docType?: string; docDate?: string; sellerGstin?: string; buyerGstin?: string; totalValue?: number; ackNo?: string; ackDate?: string };

// The signed invoice is a signed token (header.payload.signature). The payload's `data` field holds the invoice as JSON.
// This only READS the payload to cross-check it against what the ERP expects; it does not verify the signature.
export function decodeSignedInvoice(token?: string | null): SignedInvoiceInfo | null {
  const parts = String(token || '').trim().split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const raw = payload?.data ?? payload;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') return null;
    const pick = (obj: any, ...keys: string[]) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null);
    const doc = pick(data, 'DocDtls', 'docDtls') || {};
    return {
      irn: pick(data, 'Irn', 'irn'),
      docNo: pick(doc, 'No', 'no') ?? pick(data, 'DocNo'),
      docType: pick(doc, 'Typ', 'typ') ?? pick(data, 'DocTyp'),
      docDate: pick(doc, 'Dt', 'dt') ?? pick(data, 'DocDt'),
      sellerGstin: pick(data, 'SellerGstin') ?? pick(pick(data, 'SellerDtls') || {}, 'Gstin'),
      buyerGstin: pick(data, 'BuyerGstin') ?? pick(pick(data, 'BuyerDtls') || {}, 'Gstin'),
      totalValue: pick(data, 'TotInvVal') !== undefined ? Number(pick(data, 'TotInvVal')) : pick(pick(data, 'ValDtls') || {}, 'TotInvVal') !== undefined ? Number(pick(pick(data, 'ValDtls'), 'TotInvVal')) : undefined,
      ackNo: pick(data, 'AckNo') !== undefined ? String(pick(data, 'AckNo')) : undefined,
      ackDate: pick(data, 'AckDt') ?? pick(data, 'IrnDt'),
    };
  } catch {
    return null;
  }
}

// Acknowledgement date as the portal prints it: "2026-10-15 14:30:05" or "15/10/2026 14:30:05", Indian time.
export function parseAckDate(value: any): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) { const d = new Date(text); return Number.isNaN(d.getTime()) ? null : d; }
  let match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  let parts: number[] | null = match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)] : null;
  if (!parts) {
    match = /^(\d{2})[/-](\d{2})[/-](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    if (match) parts = [Number(match[3]), Number(match[2]), Number(match[1]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)];
  }
  if (!parts) return null;
  const [y, mo, d, h, mi, s] = parts;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s) - 5.5 * 3600 * 1000; // read as Indian time
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type PortalRow = {
  index: number;
  docNo?: string;
  docType?: string;
  sellerGstin?: string;
  irn?: string;
  ackNo?: string;
  ackDate?: Date | null;
  ackDateRaw?: any;
  signedInvoice?: string;
  signedQr?: string;
  decoded?: SignedInvoiceInfo | null;
  decodedQr?: SignedInvoiceInfo | null;
  // The portal's own status for the IRN: ACT (active) or CNL (cancelled).
  portalStatus?: string;
  error?: { code?: string; message: string };
};

const lower = (obj: any) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v]));

// ErrorDetails arrives as a list, or as base64 text of that list.
function errorDetailsOf(value: any): any {
  if (typeof value !== 'string' || !value.trim()) return value;
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return value; }
}

// One response { Status, Data: {...}, ErrorDetails } becomes the row inside Data, carrying the errors and the overall status.
function unwrap(item: any): any {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const keys = Object.keys(item);
  const dataKey = keys.find((k) => k.toLowerCase() === 'data');
  const data = dataKey ? item[dataKey] : null;
  const errorKey = keys.find((k) => k.toLowerCase() === 'errordetails');
  const statusKey = keys.find((k) => k.toLowerCase() === 'status');
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...data, ErrorDetails: errorKey ? errorDetailsOf(item[errorKey]) : data.ErrorDetails, __overall: statusKey ? item[statusKey] : undefined };
  }
  if (errorKey && !data) return { ...item, ErrorDetails: errorDetailsOf(item[errorKey]), __overall: statusKey ? item[statusKey] : undefined };
  return item;
}

function rowsOf(json: any): any[] {
  if (Array.isArray(json)) return json.map(unwrap);
  if (json && typeof json === 'object') {
    for (const key of ['data', 'Data', 'result', 'Result', 'invoices', 'Invoices', 'response', 'Response', 'successList', 'SuccessList']) {
      if (Array.isArray(json[key])) return json[key].map(unwrap);
    }
    const failed = ['failureList', 'FailureList', 'errorList', 'ErrorList'].flatMap((key) => (Array.isArray(json[key]) ? json[key] : []));
    if (failed.length) return failed.map(unwrap);
    const single = unwrap(json);
    if (single.Irn || single.irn || single.SignedInvoice || single.ErrorDetails) return [single];
  }
  return [];
}

function errorOf(row: Record<string, any>) {
  const details = row.errordetails ?? row.errors ?? row.error;
  const first = Array.isArray(details) ? details[0] : details;
  if (first && typeof first === 'object') {
    const l = lower(first);
    return { code: l.errorcode !== undefined ? String(l.errorcode) : undefined, message: String(l.errormessage ?? l.message ?? JSON.stringify(first)) };
  }
  if (typeof first === 'string' && first) return { message: first };
  const overall = String(row.overall ?? '').trim();
  if ((overall === '0' || overall.toUpperCase() === 'FAILED') && !row.irn) return { message: 'The portal rejected this invoice (no reason in the file)' };
  const status = String(row.status ?? row.irpstatus ?? '').trim().toUpperCase();
  const message = row.errormessage ?? row.remarks ?? row.message;
  if (message && (status === 'F' || status === 'FAILED' || status === 'ERROR' || (!row.irn && !row.signedinvoice))) return { code: row.errorcode !== undefined ? String(row.errorcode) : undefined, message: String(message) };
  if (status === 'F' || status === 'FAILED' || status === 'ERROR') return { message: 'The portal rejected this invoice (no reason in the file)' };
  return undefined;
}

export function parsePortalResult(json: any): PortalRow[] {
  return rowsOf(json).map((raw, index) => {
    const row = lower(raw);
    const signedInvoice = row.signedinvoice ? String(row.signedinvoice) : undefined;
    const signedQr = row.signedqrcode ? String(row.signedqrcode) : row.signedqr ? String(row.signedqr) : undefined;
    const decoded = decodeSignedInvoice(signedInvoice);
    const decodedQr = decodeSignedInvoice(signedQr);
    const ackDateRaw = row.ackdt ?? row.ackdate ?? decoded?.ackDate ?? decodedQr?.ackDate;
    const docNo = row.docno ?? row.invoiceno ?? row.documentno ?? row.invno ?? decoded?.docNo ?? decodedQr?.docNo;
    return {
      index,
      docNo: docNo !== undefined ? String(docNo) : undefined,
      docType: (row.doctyp ?? row.doctype ?? decoded?.docType ?? decodedQr?.docType) ? String(row.doctyp ?? row.doctype ?? decoded?.docType ?? decodedQr?.docType).toUpperCase() : undefined,
      sellerGstin: normalizeGstin(String(row.sellergstin ?? row.gstin ?? row.usergstin ?? decoded?.sellerGstin ?? decodedQr?.sellerGstin ?? '')) || undefined,
      irn: row.irn ? String(row.irn).trim() : decoded?.irn ? String(decoded.irn).trim() : decodedQr?.irn ? String(decodedQr.irn).trim() : undefined,
      ackNo: row.ackno !== undefined ? String(row.ackno) : decoded?.ackNo,
      portalStatus: row.status !== undefined ? String(row.status).toUpperCase() : undefined,
      ackDate: parseAckDate(ackDateRaw),
      ackDateRaw,
      signedInvoice,
      signedQr,
      decoded,
      decodedQr,
      error: errorOf(row),
    };
  });
}

export type RowCheckTarget = { docNo: string; docType: string; sellerGstin: string; totalValue?: number };

// Checks one portal row that carries an IRN against the e-invoice it is meant for. Returns the reasons it must be rejected.
export function checkPortalRow(row: PortalRow, target: RowCheckTarget): string[] {
  const problems: string[] = [];
  if (!row.irn || !IRN_PATTERN.test(row.irn)) problems.push('IRN is missing or is not 64 hexadecimal characters');
  if (!row.ackNo || !/^\d{1,20}$/.test(row.ackNo)) problems.push('Acknowledgement number is missing or not numeric');
  if (!row.ackDate) problems.push('Acknowledgement date is missing or not readable');
  else if (row.ackDate.getTime() > Date.now() + 5 * 60 * 1000) problems.push('Acknowledgement date is in the future');
  if (!row.signedQr) problems.push('Signed QR code is missing');
  if (row.portalStatus === 'CNL') problems.push('The portal shows this IRN as cancelled');
  for (const [label, d] of [['Signed invoice', row.decoded], ['Signed QR', row.decodedQr]] as const) {
    if (!d) continue;
    if (d.docNo && String(d.docNo) !== target.docNo) problems.push(`${label} is for document ${d.docNo}, not ${target.docNo}`);
    if (d.sellerGstin && normalizeGstin(d.sellerGstin) !== target.sellerGstin) problems.push(`${label} is for GSTIN ${d.sellerGstin}, not ${target.sellerGstin}`);
    if (d.docType && String(d.docType).toUpperCase() !== target.docType) problems.push(`${label} is a ${d.docType}, not a ${target.docType}`);
    if (d.irn && row.irn && String(d.irn).toLowerCase() !== row.irn.toLowerCase()) problems.push(`IRN in the file differs from the IRN inside the ${label.toLowerCase()}`);
    if (d.totalValue !== undefined && target.totalValue !== undefined && Math.abs(d.totalValue - target.totalValue) > 1) problems.push(`${label} total ${d.totalValue} differs from the document total ${target.totalValue}`);
  }
  if (target.sellerGstin && row.sellerGstin && isValidGstin(row.sellerGstin) && row.sellerGstin !== target.sellerGstin) problems.push(`Row is for GSTIN ${row.sellerGstin}, not ${target.sellerGstin}`);
  return problems;
}
