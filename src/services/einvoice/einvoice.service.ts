import { audit } from '../../utils/erp';
import { currentCompanyId } from '../../utils/tenant';
import { dispatchGstinOptions } from '../eway/ewayBill.service';
import { isValidGstin, normalizeGstin, stateCodeFromName, stateCodeOfGstin } from '../eway/ewayRules.service';
import { round2 } from '../eway/ewayPayload.service';
import { MAX_BULK_FILE_BYTES, buildEInvoiceDraft, buildIrpBulkFile, toIrpInvoice, validateEInvoice, type EInvoiceBuildInput, type EInvoiceItemDraft, type EInvoiceLineInput } from './einvoicePayload.service';
import { IRN_PATTERN, checkPortalRow, decodeSignedInvoice, parseAckDate, parsePortalResult, type PortalRow } from './einvoiceResult.service';
import {
  CANCEL_REASON_CODES, cancelDeadline, cancelState, reportingDeadline, windowProgress, type RuleVersion,
} from './einvoiceRules.service';
import { EInvoiceError, evaluateForDocument, getConfig, ruleVersionFor, type Applicability } from './einvoiceConfig.service';

export { EInvoiceError };

// Database side of the e-invoice. Manual mode: the ERP prepares and validates the e-invoice, exports the portal's
// bulk-upload file, and the user brings the portal's result (IRN, acknowledgement, signed QR) back. Everything runs
// inside the caller's transaction (tx) so the e-invoice, its events and the audit row commit together.

export type SourceType = 'SALES_INVOICE' | 'CREDIT_NOTE';
export const LIVE_STATUSES = ['DRAFT', 'EXPORTED', 'GENERATED', 'FAILED'];
const EDITABLE_STATUSES = ['DRAFT', 'EXPORTED', 'FAILED'];

const num = (value: any) => Number(value?.toString?.() ?? value ?? 0);
const docTypeOf = (sourceType: SourceType) => (sourceType === 'SALES_INVOICE' ? 'INV' : 'CRN');

// ---- source documents -------------------------------------------------------------------------------------------

const productSelect = { select: { id: true, sku: true, name: true, type: true, hsnCode: true, unit: { select: { symbol: true, name: true } } } };

async function loadSource(tx: any, sourceType: SourceType, id: string) {
  if (sourceType === 'SALES_INVOICE') {
    const invoice = await tx.salesInvoice.findUnique({
      where: { id },
      include: { customer: true, items: { include: { product: productSelect, uom: true, taxes: true } }, salesOrder: { select: { id: true, shippingAddressSnapshot: true } } },
    });
    if (!invoice) throw new EInvoiceError('Sales invoice not found', 404);
    if (invoice.status !== 'SUBMITTED') throw new EInvoiceError('An e-invoice can only be made for a submitted invoice');
    return invoice;
  }
  const note = await tx.creditNote.findUnique({
    where: { id },
    include: {
      customer: true,
      items: { include: { product: productSelect } },
      originalInvoice: { include: { items: { include: { taxes: true } }, salesOrder: { select: { id: true, shippingAddressSnapshot: true } } } },
    },
  });
  if (!note) throw new EInvoiceError('Credit note not found', 404);
  if (note.status !== 'SUBMITTED') throw new EInvoiceError('An e-invoice can only be made for a submitted credit note');
  return note;
}

const sourceWhere = (sourceType: SourceType, id: string) => (sourceType === 'SALES_INVOICE' ? { salesInvoiceId: id } : { creditNoteId: id });

// Exports and SEZ supplies are reported even when the buyer has no ordinary GSTIN.
const exportOrSezOf = (customer: any) => Boolean(customer?.isSez) || !['INDIA', 'IN', ''].includes(String(customer?.country || 'India').trim().toUpperCase());

function buyerGstinOf(customer: any) {
  const gstin = normalizeGstin(customer?.gstin);
  if (gstin) return gstin;
  return isValidGstin(customer?.taxId) ? normalizeGstin(customer.taxId) : '';
}

function addressParts(snapshot: any, fallback: any) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    addr1: value.address || fallback?.address || null,
    place: value.city || fallback?.city || null,
    pincode: String(value.zip || value.pincode || fallback?.zip || '').trim() || null,
    stateCode: stateCodeFromName(value.state || fallback?.state) || value.stateCode || fallback?.stateCode || null,
  };
}

// Lines of the document with their taxable value and tax rows. A credit note carries no tax rows of its own, so each
// line takes the tax rows of the matching line of the original invoice: the credit then reverses the tax types charged.
function sourceLines(sourceType: SourceType, source: any): { lines: EInvoiceLineInput[]; warnings: string[] } {
  const warnings: string[] = [];
  if (sourceType === 'SALES_INVOICE') {
    const lines = source.items.map((item: any): EInvoiceLineInput => {
      const quantity = num(item.quantity);
      const rate = num(item.rate ?? item.unitPrice);
      const taxable = num(item.netAmount) > 0 ? num(item.netAmount) : round2(quantity * rate * (1 - num(item.discount) / 100));
      return {
        productId: item.productId, productName: item.product?.name || item.description || item.itemCode, description: item.description || item.product?.name,
        isService: item.product?.type === 'SERVICE', hsnCode: item.hsnCode || item.product?.hsnCode,
        unitSymbol: item.uom?.symbol || item.product?.unit?.symbol || item.product?.unit?.name,
        quantity, unitPrice: rate, taxableAmount: taxable, taxRate: num(item.taxRate),
        taxes: (item.taxes || []).map((tax: any) => ({ label: tax.label, rate: num(tax.rate) })),
      };
    });
    return { lines, warnings };
  }
  const used = new Set<string>();
  const original = source.originalInvoice?.items || [];
  const lines = source.items.map((item: any): EInvoiceLineInput => {
    const match = original.find((line: any) => !used.has(line.id) && line.productId === item.productId) || original.find((line: any) => line.productId === item.productId);
    if (match) used.add(match.id);
    const quantity = num(item.quantity);
    const rate = num(item.rate);
    const taxable = num(item.netAmount) > 0 ? num(item.netAmount) : round2(quantity * rate * (1 - num(item.discount) / 100));
    let taxRate = match ? num(match.taxRate) : 0;
    if (!match) {
      taxRate = taxable > 0 ? round2(num(item.taxAmount) / taxable * 100) : 0;
      warnings.push(`${item.itemCode || item.product?.sku}: not on the original invoice, tax rate ${taxRate}% taken from the credit note`);
    }
    return {
      productId: item.productId, productName: item.product?.name || item.description || item.itemCode, description: item.description || item.product?.name,
      isService: item.product?.type === 'SERVICE', hsnCode: item.hsnCode || item.product?.hsnCode, unitSymbol: item.product?.unit?.symbol || item.product?.unit?.name,
      quantity, unitPrice: rate, taxableAmount: taxable, taxRate,
      taxes: (match?.taxes || []).map((tax: any) => ({ label: tax.label, rate: num(tax.rate) })),
    };
  });
  return { lines, warnings };
}

// The seller block: the chosen company GSTIN with its address, falling back to the company's own address.
async function sellerFor(tx: any, gstinInput?: string | null) {
  const options = await dispatchGstinOptions(tx);
  if (!options.length) throw new EInvoiceError('The company has no valid GSTIN. Add it under company settings');
  const wanted = normalizeGstin(gstinInput);
  const option = wanted ? options.find((o: any) => o.gstin === wanted) : options.length === 1 ? options[0] : options[0];
  if (!option) throw new EInvoiceError('Seller GSTIN is not one of the company GSTINs');
  const companyId = currentCompanyId();
  const company = companyId ? await tx.company.findUnique({ where: { id: companyId } }) : await tx.company.findFirst({});
  const registration = option.address && typeof option.address === 'object' ? option.address : {};
  return {
    seller: {
      gstin: option.gstin,
      legalName: option.legalName || company?.legalName || company?.name,
      addr1: registration.address ?? registration.line1 ?? company?.address ?? null,
      addr2: registration.addr2 ?? null,
      place: registration.city ?? company?.city ?? null,
      pincode: registration.pincode ?? registration.zip ?? company?.zip ?? null,
      stateCode: option.stateCode,
    },
    company,
    exempt: Boolean(company?.einvoiceExempt),
    choices: options,
  };
}

async function buildFromSource(tx: any, sourceType: SourceType, source: any, input: Record<string, any>) {
  const seller = await sellerFor(tx, input.sellerGstin);
  const customer = source.customer;
  const invoice = sourceType === 'SALES_INVOICE' ? source : source.originalInvoice;
  const snapshot = invoice?.shippingAddressSnapshot || invoice?.salesOrder?.shippingAddressSnapshot || null;
  const bill = addressParts(null, customer);
  const rule = await ruleVersionFor(tx, new Date(source.date));
  const { lines, warnings: lineWarnings } = sourceLines(sourceType, source);
  const ship = snapshot ? addressParts(snapshot, customer) : null;
  const buildInput: EInvoiceBuildInput = {
    docType: docTypeOf(sourceType),
    doc: sourceType === 'SALES_INVOICE'
      ? { docNo: source.invoiceNo, docDate: source.date, grandTotal: num(source.grandTotal), invoiceDiscount: num(source.discount) }
      : { docNo: source.creditNoteNo, docDate: source.date, grandTotal: num(source.grandTotal), invoiceDiscount: 0 },
    preceding: sourceType === 'CREDIT_NOTE' ? { docNo: source.originalInvoice.invoiceNo, docDate: source.originalInvoice.date } : null,
    seller: seller.seller,
    buyer: { name: customer.name, gstin: buyerGstinOf(customer), stateCode: customer.stateCode || bill.stateCode, country: snapshot?.country || customer.country, isSez: Boolean(customer.isSez), addr1: bill.addr1, place: bill.place, pincode: bill.pincode },
    shipTo: ship ? { gstin: snapshot?.gstin, name: customer.name, addr1: ship.addr1, place: ship.place, pincode: ship.pincode, stateCode: ship.stateCode } : null,
    lines,
    overrides: { supplyType: input.supplyType, placeOfSupply: input.placeOfSupply },
    rule,
  };
  const draft = buildEInvoiceDraft(buildInput);
  const applicability = await evaluateForDocument(tx, {
    docType: buildInput.docType, docDate: new Date(source.date), supplierGstin: seller.seller.gstin, buyerGstin: draft.einvoice.buyerGstin,
    exportOrSez: draft.einvoice.buyerGstin === 'URP' || Boolean(customer.isSez), companyExempt: seller.exempt, fiscalYearStartMonth: seller.company?.fiscalYearStart || 4,
  });
  // The portal takes every amount in rupees; a document in another currency would be reported with the wrong values.
  const currencyWarnings = source.currency && String(source.currency).toUpperCase() !== 'INR' ? [`This document is in ${source.currency}. The portal takes amounts in INR, so the values below are not valid until the document is in INR`] : [];
  return { draft, applicability, warnings: [...currencyWarnings, ...lineWarnings, ...draft.warnings, ...applicability.warnings], seller };
}

function deadlineFor(applicability: Applicability, docDate: Date) {
  if (applicability.status !== 'REQUIRED' || !applicability.rule) return null;
  return reportingDeadline(docDate, applicability.rule, applicability.turnover);
}

// ---- requirement check (soft warning) ---------------------------------------------------------------------------------

async function liveFor(tx: any, sourceType: SourceType, id: string) {
  return tx.eInvoice.findFirst({ where: { ...sourceWhere(sourceType, id), status: { in: LIVE_STATUSES } }, orderBy: { createdAt: 'desc' } });
}

export async function checkRequirement(tx: any, sourceType: SourceType, sourceId: string) {
  const source = await loadSource(tx, sourceType, sourceId).catch((err) => { if (err instanceof EInvoiceError && err.status === 400) return null; throw err; });
  if (!source) return { required: false, state: 'NOT_AVAILABLE', reason: 'The document is not submitted', einvoice: null, deadline: null, percentUsed: null };
  const config = await getConfig(tx);
  const existing = await liveFor(tx, sourceType, sourceId);
  const seller = await sellerFor(tx, null).catch(() => null);
  const applicability = seller
    ? await evaluateForDocument(tx, {
      docType: docTypeOf(sourceType), docDate: new Date(source.date), supplierGstin: seller.seller.gstin, buyerGstin: buyerGstinOf(source.customer),
      exportOrSez: exportOrSezOf(source.customer), companyExempt: seller.exempt, fiscalYearStartMonth: seller.company?.fiscalYearStart || 4,
    })
    : null;
  const required = applicability?.status === 'REQUIRED';
  const deadline = applicability ? deadlineFor(applicability, new Date(source.date)) : null;
  const progress = deadline && applicability?.rule ? windowProgress(new Date(), new Date(source.date), deadline, applicability.rule.warnAtPercents) : null;
  const state = existing ? 'HAS_EINVOICE' : !applicability || applicability.needsAttention ? 'NEEDS_CONFIG' : required ? 'REQUIRED_MISSING' : 'NOT_REQUIRED';
  return {
    required, state, reason: applicability?.reason ?? 'The company has no valid GSTIN', warnings: applicability?.warnings ?? [],
    hardBlock: Boolean(config.hardBlockOnSubmit && required && !existing),
    deadline, percentUsed: progress ? Math.round(progress.percentUsed) : null, breached: progress?.breached ?? false,
    einvoice: existing ? { id: existing.id, status: existing.status, irn: existing.irn, ackNo: existing.ackNo, ackDate: existing.ackDate, errorMessage: existing.errorMessage } : null,
  };
}

// ---- create / read / edit ------------------------------------------------------------------------------------------------

function rowData(e: Record<string, any>) {
  const { precedingDocDate, ...rest } = e;
  return { ...rest, precedingDocDate: precedingDocDate || null };
}

export async function createFromSource(tx: any, req: any, input: { sourceType: SourceType; sourceId: string; sellerGstin?: string; dryRun?: boolean } & Record<string, any>) {
  if (!['SALES_INVOICE', 'CREDIT_NOTE'].includes(input.sourceType)) throw new EInvoiceError('sourceType must be SALES_INVOICE or CREDIT_NOTE');
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `einvoice-create:${input.sourceType}:${input.sourceId}`);
  const source = await loadSource(tx, input.sourceType, input.sourceId);
  if (!input.dryRun) {
    const existing = await liveFor(tx, input.sourceType, input.sourceId);
    if (existing) throw new EInvoiceError(`An e-invoice for ${source.invoiceNo || source.creditNoteNo} already exists (${existing.status}). Cancel or delete it before making another`, 409);
  }
  const { draft, applicability, warnings } = await buildFromSource(tx, input.sourceType, source, input);
  if (input.dryRun) return { preview: true, einvoice: draft.einvoice, items: draft.items, errors: draft.errors, warnings, applicability: { status: applicability.status, reason: applicability.reason } };

  const created = await tx.eInvoice.create({
    data: {
      ...rowData(draft.einvoice),
      status: 'DRAFT', source: 'MANUAL', sourceType: input.sourceType, createdById: req.user?.id,
      financialYear: applicability.financialYear, ruleVersionId: applicability.ruleVersionId, reportingDeadline: deadlineFor(applicability, new Date(source.date)),
      ...sourceWhere(input.sourceType, input.sourceId),
      items: { create: draft.items },
      events: { create: { type: 'CREATED', userId: req.user?.id, data: { sourceType: input.sourceType, sourceId: input.sourceId } } },
    },
    include: { items: true },
  });
  await audit(tx, req, { entityType: 'EINVOICE', entityId: created.id, action: 'CREATE', statusAfter: 'DRAFT', message: `Prepared e-invoice for ${created.docNo}` });
  return { einvoice: created, errors: draft.errors, warnings, applicability: { status: applicability.status, reason: applicability.reason } };
}

export async function getEInvoice(tx: any, id: string) {
  const einvoice = await tx.eInvoice.findUnique({
    where: { id },
    include: {
      items: { orderBy: { slNo: 'asc' } }, events: { orderBy: { createdAt: 'desc' } },
      salesInvoice: { select: { id: true, invoiceNo: true, status: true } }, creditNote: { select: { id: true, creditNoteNo: true, status: true } },
    },
  });
  if (!einvoice) throw new EInvoiceError('E-invoice not found', 404);
  return einvoice;
}

const itemNumbers = (items: any[]): EInvoiceItemDraft[] => items.map((item) => ({
  ...item, quantity: num(item.quantity), unitPrice: num(item.unitPrice), grossAmount: num(item.grossAmount), discount: num(item.discount), taxableAmount: num(item.taxableAmount),
  cgstRate: num(item.cgstRate), sgstRate: num(item.sgstRate), igstRate: num(item.igstRate), cessRate: num(item.cessRate),
  cgstAmount: num(item.cgstAmount), sgstAmount: num(item.sgstAmount), igstAmount: num(item.igstAmount), cessAmount: num(item.cessAmount), totalItemValue: num(item.totalItemValue),
}));

export async function validationFor(tx: any, einvoice: any) {
  const rule = await ruleVersionFor(tx, new Date(einvoice.docDate));
  return validateEInvoice(einvoice, itemNumbers(einvoice.items), rule, einvoice.buyerGstin === 'URP');
}

export async function cancelInfo(tx: any, einvoice: any) {
  if (einvoice.status !== 'GENERATED' || !einvoice.ackDate) return null;
  const rule = await ruleVersionFor(tx, new Date(einvoice.ackDate));
  if (!rule) return { known: false, canCancel: true, deadline: null, secondsLeft: null, reasonIfNot: null, note: 'No rule version is configured, so the cancellation window is not checked' };
  return { known: true, ...cancelState(new Date(), new Date(einvoice.ackDate), rule) };
}

const EDITABLE = [
  'supplyType', 'reverseCharge', 'precedingDocNo',
  'sellerName', 'sellerAddr1', 'sellerAddr2', 'sellerPlace', 'sellerPincode', 'sellerStateCode',
  'buyerGstin', 'buyerName', 'buyerAddr1', 'buyerAddr2', 'buyerPlace', 'buyerPincode', 'buyerStateCode', 'placeOfSupply',
  'hasShipTo', 'shipToGstin', 'shipToName', 'shipToAddr1', 'shipToAddr2', 'shipToPlace', 'shipToPincode', 'shipToStateCode',
];

// Redoes line and document values after the supply direction changed (seller state, place of supply, buyer GSTIN).
async function resplit(tx: any, id: string) {
  const e = await tx.eInvoice.findUnique({ where: { id }, include: { items: true } });
  const isExport = e.buyerGstin === 'URP';
  const interState = isExport || String(e.supplyType || '').startsWith('SEZ') || (!!e.sellerStateCode && !!e.placeOfSupply && e.sellerStateCode !== e.placeOfSupply);
  const totals = { cgst: 0, sgst: 0, igst: 0, cess: 0, taxable: 0, lines: 0 };
  for (const item of e.items) {
    const gst = num(item.cgstRate) + num(item.sgstRate) + num(item.igstRate);
    const rates = interState ? { cgst: 0, sgst: 0, igst: gst } : { cgst: gst / 2, sgst: gst / 2, igst: 0 };
    const taxable = num(item.taxableAmount);
    const amounts = { cgst: round2(taxable * rates.cgst / 100), sgst: round2(taxable * rates.sgst / 100), igst: round2(taxable * rates.igst / 100), cess: round2(taxable * num(item.cessRate) / 100) };
    const lineTotal = round2(taxable + amounts.cgst + amounts.sgst + amounts.igst + amounts.cess);
    await tx.eInvoiceItem.update({ where: { id: item.id }, data: { cgstRate: rates.cgst, sgstRate: rates.sgst, igstRate: rates.igst, cgstAmount: amounts.cgst, sgstAmount: amounts.sgst, igstAmount: amounts.igst, cessAmount: amounts.cess, totalItemValue: lineTotal } });
    totals.taxable += taxable; totals.cgst += amounts.cgst; totals.sgst += amounts.sgst; totals.igst += amounts.igst; totals.cess += amounts.cess; totals.lines += lineTotal;
  }
  const computed = round2(totals.lines - num(e.discountValue) + num(e.otherCharges));
  await tx.eInvoice.update({ where: { id }, data: { taxableValue: round2(totals.taxable), cgstValue: round2(totals.cgst), sgstValue: round2(totals.sgst), igstValue: round2(totals.igst), cessValue: round2(totals.cess), roundOff: round2(num(e.totalValue) - computed) } });
}

export async function updateDraft(tx: any, req: any, id: string, input: any) {
  const einvoice = await getEInvoice(tx, id);
  if (!EDITABLE_STATUSES.includes(einvoice.status)) throw new EInvoiceError('Only a draft, exported or failed e-invoice can be edited');
  const data: any = {};
  for (const key of EDITABLE) if (input[key] !== undefined) data[key] = input[key] === '' ? null : input[key];
  for (const key of ['buyerGstin', 'shipToGstin']) if (data[key] !== undefined && data[key] !== null) data[key] = normalizeGstin(data[key]);
  if (data.buyerGstin !== undefined && data.buyerGstin && isValidGstin(data.buyerGstin) && input.buyerStateCode === undefined) data.buyerStateCode = stateCodeOfGstin(data.buyerGstin);
  if (data.buyerGstin === null) data.buyerGstin = '';
  if (input.precedingDocDate !== undefined) data.precedingDocDate = input.precedingDocDate ? new Date(input.precedingDocDate) : null;
  if (data.reverseCharge !== undefined) data.reverseCharge = Boolean(data.reverseCharge);
  if (data.hasShipTo !== undefined) data.hasShipTo = Boolean(data.hasShipTo);
  // An edit means any file already uploaded is stale, and a rejected e-invoice gets a fresh try.
  data.status = 'DRAFT'; data.errorCode = null; data.errorMessage = null;
  await tx.eInvoice.update({ where: { id }, data });
  for (const edit of input.items || []) {
    const row = einvoice.items.find((item: any) => item.id === edit.id);
    if (!row) continue;
    const itemData: any = {};
    if (edit.hsnCode !== undefined) itemData.hsnCode = String(edit.hsnCode).replace(/\s+/g, '');
    if (edit.unit !== undefined) itemData.unit = String(edit.unit).toUpperCase();
    if (Object.keys(itemData).length) await tx.eInvoiceItem.update({ where: { id: row.id }, data: itemData });
  }
  // Changing where the goods are supplied from or to redoes the tax split. `resplit: true` asks for it on purpose: it
  // re-types the tax on this e-invoice (CGST+SGST <-> IGST) to match the supply direction, which differs from the tax
  // rows on the invoice itself, so it is for the CA to approve and is recorded in the event log.
  const resplitRequested = input.resplit === true;
  const resplitReason = String(input.resplitReason || '').trim();
  if (resplitRequested && !resplitReason) throw new EInvoiceError('Say who approved re-typing the tax (for example "approved by CA A. Sharma, ref 12") before it is changed');
  if (resplitRequested || ['sellerStateCode', 'placeOfSupply', 'buyerGstin'].some((key) => data[key] !== undefined)) await resplit(tx, id);
  await tx.eInvoiceEvent.create({ data: { einvoiceId: id, type: 'EDITED', userId: req.user?.id, data: { fields: [...Object.keys(data).filter((k) => !['status', 'errorCode', 'errorMessage'].includes(k)), ...(input.items?.length ? ['items'] : []), ...(resplitRequested ? ['taxResplit'] : [])], ...(resplitRequested ? { resplitReason } : {}) } } });
  await audit(tx, req, { entityType: 'EINVOICE', entityId: id, action: 'UPDATE', statusBefore: einvoice.status, statusAfter: 'DRAFT', message: `Edited e-invoice ${einvoice.docNo}${resplitRequested ? ` (tax re-typed to match the supply: ${resplitReason})` : ''}` });
  return getEInvoice(tx, id);
}

// Pulls the document and the master data again (customer GSTIN, addresses, HSN, units), keeping the chosen seller GSTIN.
// This is how a rejected or invalid e-invoice is fixed after the data was corrected at its source.
export async function refreshFromSource(tx: any, req: any, id: string) {
  const einvoice = await getEInvoice(tx, id);
  if (!EDITABLE_STATUSES.includes(einvoice.status)) throw new EInvoiceError('Only a draft, exported or failed e-invoice can be refreshed');
  const sourceType = einvoice.sourceType as SourceType;
  const sourceId = sourceType === 'SALES_INVOICE' ? einvoice.salesInvoiceId : einvoice.creditNoteId;
  const source = await loadSource(tx, sourceType, sourceId);
  const { draft, applicability, warnings } = await buildFromSource(tx, sourceType, source, { sellerGstin: einvoice.sellerGstin });
  await tx.eInvoiceItem.deleteMany({ where: { einvoiceId: id } });
  await tx.eInvoice.update({
    where: { id },
    data: {
      ...rowData(draft.einvoice), status: 'DRAFT', errorCode: null, errorMessage: null, payload: undefined,
      financialYear: applicability.financialYear, ruleVersionId: applicability.ruleVersionId, reportingDeadline: deadlineFor(applicability, new Date(source.date)),
      items: { create: draft.items },
    },
  });
  await tx.eInvoiceEvent.create({ data: { einvoiceId: id, type: 'REFRESHED', userId: req.user?.id } });
  await audit(tx, req, { entityType: 'EINVOICE', entityId: id, action: 'REFRESH', statusBefore: einvoice.status, statusAfter: 'DRAFT', message: `Refreshed e-invoice ${einvoice.docNo} from its document` });
  return { einvoice: await getEInvoice(tx, id), errors: draft.errors, warnings };
}

export async function deleteDraft(tx: any, req: any, id: string) {
  const einvoice = await getEInvoice(tx, id);
  if (!EDITABLE_STATUSES.includes(einvoice.status)) throw new EInvoiceError('Only a draft, exported or failed e-invoice can be deleted; cancel a generated one instead');
  await audit(tx, req, { entityType: 'EINVOICE', entityId: id, action: 'DELETE', statusBefore: einvoice.status, message: `Deleted e-invoice ${einvoice.docNo}` });
  await tx.eInvoice.delete({ where: { id } });
}

// ---- export ----------------------------------------------------------------------------------------------------------------

// Builds the portal's bulk-upload file. Every e-invoice must pass validation first: a file the portal would reject
// wastes the user's trip to the portal.
export async function exportEInvoices(tx: any, req: any, ids: string[]) {
  if (!ids.length) throw new EInvoiceError('Select at least one e-invoice to export');
  const rows = await tx.eInvoice.findMany({ where: { id: { in: ids } }, include: { items: { orderBy: { slNo: 'asc' } } } });
  if (rows.length !== new Set(ids).size) throw new EInvoiceError('One or more e-invoices were not found', 404);
  const problems: string[] = [];
  for (const row of rows) {
    if (!EDITABLE_STATUSES.includes(row.status)) { problems.push(`${row.docNo}: already ${row.status.toLowerCase()}, nothing to export`); continue; }
    for (const message of await validationFor(tx, row)) problems.push(`${row.docNo}: ${message}`);
  }
  if (problems.length) throw new EInvoiceError('Fix these problems before exporting', 400, problems);
  const entries: Record<string, any>[] = [];
  for (const row of rows) {
    const rule = await ruleVersionFor(tx, new Date(row.docDate));
    entries.push(toIrpInvoice(row, row.items, rule?.schemaVersion || undefined));
  }
  // The portal rejects a bulk upload file larger than 2 MB.
  const bytes = Buffer.byteLength(JSON.stringify(buildIrpBulkFile(entries)), 'utf8');
  if (bytes > MAX_BULK_FILE_BYTES) throw new EInvoiceError(`The file would be ${(bytes / 1048576).toFixed(1)} MB but the portal accepts at most 2 MB. Select fewer e-invoices and export in more than one go`);
  for (const [index, row] of rows.entries()) {
    const entry = entries[index];
    await tx.eInvoice.update({ where: { id: row.id }, data: { status: 'EXPORTED', exportedAt: new Date(), payload: entry, errorCode: null, errorMessage: null } });
    await tx.eInvoiceEvent.create({ data: { einvoiceId: row.id, type: 'EXPORTED', userId: req.user?.id } });
    await audit(tx, req, { entityType: 'EINVOICE', entityId: row.id, action: 'EXPORT', statusBefore: row.status, statusAfter: 'EXPORTED', message: `Exported e-invoice ${row.docNo}` });
  }
  return buildIrpBulkFile(entries);
}

// ---- result: IRN, errors ---------------------------------------------------------------------------------------------------

async function notifyAccounts(tx: any, input: { type: string; title: string; message: string; link: string }) {
  const users = await tx.user.findMany({ where: { isActive: true }, select: { id: true } });
  if (users.length) await tx.notification.createMany({ data: users.map((user: any) => ({ userId: user.id, type: input.type, title: input.title, message: input.message, link: input.link })) });
}

async function applyIrn(tx: any, req: any, einvoice: any, row: PortalRow, via: 'IMPORT' | 'MANUAL') {
  const ackDate = row.ackDate as Date;
  const rule = await ruleVersionFor(tx, ackDate);
  await tx.eInvoice.update({
    where: { id: einvoice.id },
    data: {
      status: 'GENERATED', source: 'MANUAL', irn: row.irn!.toLowerCase(), ackNo: row.ackNo, ackDate,
      signedInvoice: row.signedInvoice ?? null, signedQr: row.signedQr, errorCode: null, errorMessage: null,
      cancelDeadline: rule ? cancelDeadline(ackDate, rule) : null,
    },
  });
  await tx.eInvoiceEvent.create({ data: { einvoiceId: einvoice.id, type: 'IRN_RECORDED', userId: req.user?.id, data: { via, irn: row.irn, ackNo: row.ackNo, ackDate } } });
  await audit(tx, req, { entityType: 'EINVOICE', entityId: einvoice.id, action: 'RECORD_IRN', statusBefore: einvoice.status, statusAfter: 'GENERATED', message: `Recorded IRN ${row.irn} on ${einvoice.docNo}` });
}

async function applyError(tx: any, req: any, einvoice: any, error: { code?: string; message: string }, via: 'IMPORT' | 'MANUAL') {
  await tx.eInvoice.update({ where: { id: einvoice.id }, data: { status: 'FAILED', errorCode: error.code ?? null, errorMessage: error.message } });
  await tx.eInvoiceEvent.create({ data: { einvoiceId: einvoice.id, type: 'ERROR_RECORDED', userId: req.user?.id, data: { via, ...error } } });
  await audit(tx, req, { entityType: 'EINVOICE', entityId: einvoice.id, action: 'RECORD_ERROR', statusBefore: einvoice.status, statusAfter: 'FAILED', message: `Portal rejected ${einvoice.docNo}: ${error.code ? `${error.code} ` : ''}${error.message}` });
  await notifyAccounts(tx, { type: 'EINVOICE_FAILED', title: `E-invoice rejected: ${einvoice.docNo}`, message: `${error.code ? `${error.code}: ` : ''}${error.message}`, link: `/invoicing/einvoice/${einvoice.id}` });
}

function normalisedRow(input: any): PortalRow {
  const signedInvoice = input.signedInvoice ? String(input.signedInvoice).trim() : undefined;
  return {
    index: 0,
    irn: String(input.irn || '').trim(),
    ackNo: input.ackNo !== undefined && input.ackNo !== '' ? String(input.ackNo).trim() : undefined,
    ackDate: parseAckDate(input.ackDate),
    ackDateRaw: input.ackDate,
    signedInvoice,
    signedQr: input.signedQr ? String(input.signedQr).trim() : undefined,
    decoded: decodeSignedInvoice(signedInvoice),
    decodedQr: decodeSignedInvoice(input.signedQr ? String(input.signedQr).trim() : undefined),
  };
}

async function assertIrnUnused(tx: any, irn: string, exceptId: string) {
  const duplicate = await tx.eInvoice.findFirst({ where: { irn: { equals: irn, mode: 'insensitive' }, id: { not: exceptId } }, select: { docNo: true } });
  if (duplicate) throw new EInvoiceError(`IRN ${irn} is already recorded on ${duplicate.docNo}`, 409);
}

// Typed entry of the portal's values, for one e-invoice.
export async function recordIrn(tx: any, req: any, id: string, input: any) {
  const einvoice = await getEInvoice(tx, id);
  if (!EDITABLE_STATUSES.includes(einvoice.status)) throw new EInvoiceError(`This e-invoice is already ${einvoice.status.toLowerCase()}`);
  const row = normalisedRow(input);
  const problems = checkPortalRow(row, { docNo: einvoice.docNo, docType: einvoice.docType, sellerGstin: einvoice.sellerGstin, totalValue: num(einvoice.totalValue) });
  if (problems.length) throw new EInvoiceError('The portal values are not acceptable', 400, problems);
  await assertIrnUnused(tx, row.irn!, id);
  await applyIrn(tx, req, einvoice, row, 'MANUAL');
  return getEInvoice(tx, id);
}

export async function recordError(tx: any, req: any, id: string, input: { code?: string; message?: string }) {
  const einvoice = await getEInvoice(tx, id);
  if (!['EXPORTED', 'DRAFT', 'FAILED'].includes(einvoice.status)) throw new EInvoiceError(`This e-invoice is already ${einvoice.status.toLowerCase()}`);
  const message = String(input.message || '').trim();
  if (!message) throw new EInvoiceError('Enter the error message the portal gave');
  await applyError(tx, req, einvoice, { code: input.code ? String(input.code).trim() : undefined, message }, 'MANUAL');
  return getEInvoice(tx, id);
}

// Reads the result file downloaded from the portal and applies every row it can. A bad row never stops the others.
export async function importResult(tx: any, req: any, json: any) {
  const rows = parsePortalResult(json);
  if (!rows.length) throw new EInvoiceError('No rows were found in this file. Upload the result file downloaded from the e-invoice portal');
  const accepted: any[] = []; const failed: any[] = []; const skipped: any[] = []; const rejected: any[] = [];
  const pending = await tx.eInvoice.findMany({ where: { status: { in: EDITABLE_STATUSES } }, include: { items: false } });
  for (const row of rows) {
    const label = row.docNo || `row ${row.index + 1}`;
    let candidates = pending.filter((e: any) => (row.docNo ? e.docNo === row.docNo : false));
    if (row.docType) candidates = candidates.filter((e: any) => e.docType === row.docType);
    if (row.sellerGstin) candidates = candidates.filter((e: any) => e.sellerGstin === row.sellerGstin);
    if (!candidates.length) {
      const done = row.irn ? await tx.eInvoice.findFirst({ where: { irn: { equals: row.irn, mode: 'insensitive' } }, select: { docNo: true, status: true } }) : null;
      if (done) skipped.push({ index: row.index, docNo: done.docNo, reason: `Already recorded (${done.status.toLowerCase()})` });
      else rejected.push({ index: row.index, docNo: row.docNo, reasons: [row.docNo ? `No exported e-invoice found for document ${row.docNo}` : 'The row has no document number, so it cannot be matched'] });
      continue;
    }
    if (candidates.length > 1) { rejected.push({ index: row.index, docNo: label, reasons: ['More than one e-invoice matches this row; record it on the e-invoice directly'] }); continue; }
    const einvoice = candidates[0];
    if (row.error && !row.irn) {
      await applyError(tx, req, einvoice, row.error, 'IMPORT');
      failed.push({ index: row.index, docNo: einvoice.docNo, code: row.error.code, message: row.error.message });
      continue;
    }
    const problems = checkPortalRow(row, { docNo: einvoice.docNo, docType: einvoice.docType, sellerGstin: einvoice.sellerGstin, totalValue: num(einvoice.totalValue) });
    if (!problems.length) {
      const duplicate = await tx.eInvoice.findFirst({ where: { irn: { equals: row.irn!, mode: 'insensitive' }, id: { not: einvoice.id } }, select: { docNo: true } });
      if (duplicate) problems.push(`IRN is already recorded on ${duplicate.docNo}`);
    }
    if (problems.length) { rejected.push({ index: row.index, docNo: einvoice.docNo, reasons: problems }); continue; }
    await applyIrn(tx, req, einvoice, row, 'IMPORT');
    const position = pending.indexOf(einvoice);
    if (position >= 0) pending.splice(position, 1);
    accepted.push({ index: row.index, docNo: einvoice.docNo, irn: row.irn });
  }
  await audit(tx, req, { entityType: 'EINVOICE', entityId: 'import', action: 'IMPORT_RESULT', message: `Imported portal result: ${accepted.length} recorded, ${failed.length} rejected by portal, ${skipped.length} skipped, ${rejected.length} not accepted` });
  return { accepted, failed, skipped, rejected, total: rows.length };
}

// ---- cancel -------------------------------------------------------------------------------------------------------------------

// Records an IRN cancellation done on the portal. The portal only allows it inside the window, so a record outside
// the window is refused here and the user is pointed to a credit note.
export async function recordCancel(tx: any, req: any, id: string, input: { reasonCode?: string; remark?: string }) {
  const einvoice = await getEInvoice(tx, id);
  if (einvoice.status !== 'GENERATED') throw new EInvoiceError('Only a generated e-invoice can be cancelled');
  const reasonCode = String(input.reasonCode || '');
  if (!CANCEL_REASON_CODES[reasonCode]) throw new EInvoiceError('Choose a cancellation reason: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others');
  const info = await cancelInfo(tx, einvoice);
  if (info?.known && !info.canCancel) throw new EInvoiceError(info.reasonIfNot || 'The cancellation window has passed. Issue a credit note instead', 400);
  const ewayLive = await tx.ewayBill.findFirst({ where: { ...(einvoice.salesInvoiceId ? { salesInvoiceId: einvoice.salesInvoiceId } : { id: '__none__' }), status: { in: ['GENERATED', 'EXPIRED'] } }, select: { billNo: true } });
  if (ewayLive) throw new EInvoiceError(`Cancel e-way bill ${ewayLive.billNo} first: the portal does not allow cancelling an IRN that has a live e-way bill`);
  await tx.eInvoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReasonCode: reasonCode, cancelRemark: input.remark?.trim() || null } });
  await tx.eInvoiceEvent.create({ data: { einvoiceId: id, type: 'CANCELLED', userId: req.user?.id, data: { reasonCode, remark: input.remark } } });
  await audit(tx, req, { entityType: 'EINVOICE', entityId: id, action: 'CANCEL', statusBefore: einvoice.status, statusAfter: 'CANCELLED', message: `Cancelled IRN of ${einvoice.docNo}: ${CANCEL_REASON_CODES[reasonCode]}` });
  return { einvoice: await getEInvoice(tx, id), warnings: info && !info.known ? [info.note] : [] };
}

// Guard for cancelling the invoice or credit note itself (same idea as the e-way bill guard). A draft or failed
// e-invoice has no IRN and is discarded; an exported one may already be on the portal, and a generated one has an IRN.
export async function assertNoLiveEInvoice(tx: any, where: { salesInvoiceId?: string; creditNoteId?: string }) {
  const rows = await tx.eInvoice.findMany({ where: { ...where, status: { in: LIVE_STATUSES } } });
  const generated = rows.find((row: any) => row.status === 'GENERATED');
  if (generated) throw new Error(`${generated.docNo} has an IRN. Cancel the IRN first (allowed only inside the cancellation window); after that window, issue a credit note instead`);
  const exported = rows.find((row: any) => row.status === 'EXPORTED');
  if (exported) throw new Error(`The e-invoice for ${exported.docNo} was exported and may already be on the portal. Record its result, or delete the exported e-invoice, before cancelling`);
  if (rows.length) await tx.eInvoice.deleteMany({ where: { id: { in: rows.map((row: any) => row.id) } } });
}

// ---- reports ----------------------------------------------------------------------------------------------------------------------

// Submitted documents that must be reported but have no generated e-invoice, oldest deadline first.
export async function unreportedReport(tx: any, days = 60) {
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
  const seller = await sellerFor(tx, null).catch(() => null);
  if (!seller) return { items: [], note: 'The company has no valid GSTIN' };
  const [invoices, notes, einvoices] = await Promise.all([
    tx.salesInvoice.findMany({ where: { status: 'SUBMITTED', date: { gte: since } }, include: { customer: true }, orderBy: { date: 'asc' }, take: 500 }),
    tx.creditNote.findMany({ where: { status: 'SUBMITTED', date: { gte: since } }, include: { customer: true }, orderBy: { date: 'asc' }, take: 500 }),
    tx.eInvoice.findMany({ where: { status: { in: LIVE_STATUSES } }, select: { id: true, status: true, salesInvoiceId: true, creditNoteId: true } }),
  ]);
  const bySource = new Map<string, any>();
  for (const row of einvoices) bySource.set(row.salesInvoiceId ? `SALES_INVOICE:${row.salesInvoiceId}` : `CREDIT_NOTE:${row.creditNoteId}`, row);
  const items: any[] = [];
  const consider = async (sourceType: SourceType, doc: any, docNo: string) => {
    const existing = bySource.get(`${sourceType}:${doc.id}`);
    if (existing?.status === 'GENERATED') return;
    const applicability = await evaluateForDocument(tx, {
      docType: docTypeOf(sourceType), docDate: new Date(doc.date), supplierGstin: seller.seller.gstin, buyerGstin: buyerGstinOf(doc.customer),
      exportOrSez: exportOrSezOf(doc.customer), companyExempt: seller.exempt, fiscalYearStartMonth: seller.company?.fiscalYearStart || 4,
    });
    if (applicability.status !== 'REQUIRED') return;
    const deadline = deadlineFor(applicability, new Date(doc.date));
    const progress = deadline && applicability.rule ? windowProgress(new Date(), new Date(doc.date), deadline, applicability.rule.warnAtPercents) : null;
    items.push({
      sourceType, sourceId: doc.id, docNo, date: doc.date, customer: doc.customer?.name, value: num(doc.grandTotal),
      deadline, percentUsed: progress ? Math.round(progress.percentUsed) : null, breached: progress?.breached ?? false, warnAtPercents: applicability.rule?.warnAtPercents ?? [],
      einvoiceId: existing?.id ?? null, einvoiceStatus: existing?.status ?? null,
    });
  };
  for (const invoice of invoices) await consider('SALES_INVOICE', invoice, invoice.invoiceNo);
  for (const note of notes) await consider('CREDIT_NOTE', note, note.creditNoteNo);
  items.sort((a, b) => (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity));
  return { items };
}

export async function failedReport(tx: any) {
  return tx.eInvoice.findMany({ where: { status: 'FAILED' }, orderBy: { updatedAt: 'asc' }, take: 200 });
}
