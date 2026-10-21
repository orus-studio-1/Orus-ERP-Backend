import {
  HSN_PATTERN, OTHER_COUNTRY_STATE_CODE, PINCODE_PATTERN, STATE_CODES, isValidGstin, normalizeGstin, stateCodeOfGstin, uqcFor, VALID_UQC,
} from '../eway/ewayRules.service';
import { round2, splitLineTax } from '../eway/ewayPayload.service';
import { validateDocNo, validateShipToGstin, type RuleVersion } from './einvoiceRules.service';

// Pure functions: plain data in, plain data out, so they are unit tested without a database.
// The file layout follows the e-invoice schema (version 1.1) and the NIC sandbox validations: document number 1-16
// characters, not starting with 0, / or -; dates dd/mm/yyyy; export = recipient GSTIN URP, state code 96, PIN 999999,
// place of supply 96; round-off between -99.99 and 99.99; HSN of 4, 6 or 8 digits; exports and SEZ are always inter-state.
// Not confirmed against a live portal: the layout of the BULK upload result file.

export const IRP_SCHEMA_VERSION = '1.1';
export const EXPORT_STATE_CODE = '96'; // place of supply and recipient state code for exports
export const EXPORT_PINCODE = '999999';
export const MAX_LINES = 1000; // (confirm)
export const MAX_ROUND_OFF = 99.99;
// The IRP accepts only documents dated on or after this day (NIC sandbox validation 9).
export const EARLIEST_DOC_DATE = new Date('2025-04-01T00:00:00+05:30');
// The bulk upload file may not exceed 2 MB.
export const MAX_BULK_FILE_BYTES = 2 * 1024 * 1024;
// Supply types the portal accepts for a registered-recipient e-invoice. SEZ with payment is split into authorized
// (SEZWPA) and not authorized (SEZWPNA); RCMDOM / RCMIMP are for reverse-charge supplies.
export const SUPPLY_TYPES = ['B2B', 'SEZWPA', 'SEZWPNA', 'SEZWOP', 'EXPWP', 'EXPWOP', 'DEXP', 'RCMDOM', 'RCMIMP'] as const;

export type EInvoiceLineInput = {
  productId?: string | null;
  productName: string;
  description?: string | null;
  isService?: boolean;
  hsnCode?: string | null;
  unitSymbol?: string | null;
  quantity: number;
  unitPrice: number;
  // Taxable value of the line after the line discount.
  taxableAmount: number;
  taxRate: number;
  // Tax rows stored on the document, used to split the rate into CGST / SGST / IGST / Cess.
  taxes?: Array<{ label: string; rate: number }>;
};

export type EInvoiceBuildInput = {
  docType: 'INV' | 'CRN';
  doc: { docNo: string; docDate: Date; grandTotal: number; invoiceDiscount?: number; reverseCharge?: boolean };
  preceding?: { docNo: string; docDate: Date } | null;
  seller: { gstin: string; legalName?: string | null; addr1?: string | null; addr2?: string | null; place?: string | null; pincode?: string | null; stateCode?: string | null };
  buyer: { name: string; gstin?: string | null; stateCode?: string | null; country?: string | null; isSez?: boolean; addr1?: string | null; addr2?: string | null; place?: string | null; pincode?: string | null };
  // Where the goods go, when that is not the buyer's own address.
  shipTo?: { gstin?: string | null; name?: string | null; addr1?: string | null; addr2?: string | null; place?: string | null; pincode?: string | null; stateCode?: string | null } | null;
  lines: EInvoiceLineInput[];
  overrides?: { supplyType?: string; placeOfSupply?: string | null };
  rule?: Pick<RuleVersion, 'maxDocNoLength' | 'shipToGstinMandatoryFrom'> | null;
};

export type EInvoiceItemDraft = {
  slNo: number; productId: string | null; productName: string; description: string | null; isService: boolean; hsnCode: string; quantity: number; unit: string;
  unitPrice: number; grossAmount: number; discount: number; taxableAmount: number;
  cgstRate: number; sgstRate: number; igstRate: number; cessRate: number;
  cgstAmount: number; sgstAmount: number; igstAmount: number; cessAmount: number; totalItemValue: number;
};

const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;
const sumOf = <T,>(rows: T[], pick: (row: T) => number) => round2(rows.reduce((total, row) => total + pick(row), 0));

function splitAddress(text?: string | null): [string | null, string | null] {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return [null, null];
  if (value.length <= 100) return [value, null];
  const cut = value.lastIndexOf(',', 100) > 50 ? value.lastIndexOf(',', 100) : 100;
  return [value.slice(0, cut).trim(), value.slice(cut).replace(/^,/, '').trim().slice(0, 100)];
}

const clean = (value?: string | null) => String(value ?? '').trim();

export function buildEInvoiceDraft(input: EInvoiceBuildInput) {
  const sellerGstin = normalizeGstin(input.seller.gstin);
  const sellerState = clean(input.seller.stateCode) || stateCodeOfGstin(sellerGstin) || '';
  const country = clean(input.buyer.country || 'India').toUpperCase();
  const isExport = !['INDIA', 'IN', ''].includes(country);
  const isSez = Boolean(input.buyer.isSez) && !isExport;

  let buyerGstin = normalizeGstin(input.buyer.gstin);
  let buyerState = stateCodeOfGstin(buyerGstin) || clean(input.buyer.stateCode);
  let buyerPincode = clean(input.buyer.pincode);
  const shipDiffers = Boolean(input.shipTo);
  let pos = clean(input.overrides?.placeOfSupply) || clean(input.shipTo?.stateCode) || buyerState;
  if (isExport) { buyerGstin = 'URP'; buyerState = EXPORT_STATE_CODE; pos = EXPORT_STATE_CODE; buyerPincode = EXPORT_PINCODE; }
  else if (!buyerGstin) buyerGstin = '';

  // Exports and SEZ supplies are always inter-state (IGST), whatever the states are.
  const interState = isExport || isSez || (!!sellerState && !!pos && sellerState !== pos);

  const items: EInvoiceItemDraft[] = input.lines.map((line, index) => {
    const quantity = Number(line.quantity);
    const unitPrice = Number(line.unitPrice);
    const taxable = round2(Number(line.taxableAmount));
    const gross = round2(quantity * unitPrice);
    const rates = splitLineTax({ productName: line.productName, quantity, taxableAmount: taxable, taxRate: Number(line.taxRate), taxes: line.taxes }, interState);
    const amount = (rate: number) => round2(taxable * rate / 100);
    const cgstAmount = amount(rates.cgst); const sgstAmount = amount(rates.sgst); const igstAmount = amount(rates.igst); const cessAmount = amount(rates.cess);
    return {
      slNo: index + 1,
      productId: line.productId || null,
      productName: line.productName,
      description: line.description || null,
      isService: Boolean(line.isService),
      hsnCode: String(line.hsnCode || '').replace(/\s+/g, ''),
      quantity: round3(quantity), unit: uqcFor(line.unitSymbol) || (line.isService ? 'OTH' : ''),
      unitPrice: round3(unitPrice), grossAmount: gross, discount: Math.max(0, round2(gross - taxable)), taxableAmount: taxable,
      cgstRate: rates.cgst, sgstRate: rates.sgst, igstRate: rates.igst, cessRate: rates.cess,
      cgstAmount, sgstAmount, igstAmount, cessAmount,
      totalItemValue: round2(taxable + cgstAmount + sgstAmount + igstAmount + cessAmount),
    };
  });

  const taxableValue = sumOf(items, (i) => i.taxableAmount);
  const cgstValue = sumOf(items, (i) => i.cgstAmount);
  const sgstValue = sumOf(items, (i) => i.sgstAmount);
  const igstValue = sumOf(items, (i) => i.igstAmount);
  const cessValue = sumOf(items, (i) => i.cessAmount);
  const discountValue = round2(Number(input.doc.invoiceDiscount || 0));
  const computed = round2(taxableValue + cgstValue + sgstValue + igstValue + cessValue - discountValue);
  const totalValue = round2(Number(input.doc.grandTotal));
  // Whatever separates the line values from the document total (round-off); too large a gap is an error below.
  const roundOff = round2(totalValue - computed);

  // SEZ with payment of tax is "authorized" by default; the user changes it to SEZWPNA when the SEZ unit has not authorized it.
  const supplyType = input.overrides?.supplyType || (isExport ? (igstValue > 0 ? 'EXPWP' : 'EXPWOP') : isSez ? (igstValue > 0 ? 'SEZWPA' : 'SEZWOP') : 'B2B');
  const [sellerAddr1, sellerAddr2] = input.seller.addr2 ? [clean(input.seller.addr1).slice(0, 100) || null, clean(input.seller.addr2).slice(0, 100)] : splitAddress(input.seller.addr1);
  const [buyerAddr1, buyerAddr2] = input.buyer.addr2 ? [clean(input.buyer.addr1).slice(0, 100) || null, clean(input.buyer.addr2).slice(0, 100)] : splitAddress(input.buyer.addr1);
  const ship = input.shipTo || null;
  const [shipAddr1, shipAddr2] = ship ? (ship.addr2 ? [clean(ship.addr1).slice(0, 100) || null, clean(ship.addr2).slice(0, 100)] : splitAddress(ship.addr1)) : [null, null];

  const einvoice = {
    docType: input.docType,
    docNo: input.doc.docNo,
    docDate: input.doc.docDate,
    supplyType,
    reverseCharge: Boolean(input.doc.reverseCharge),
    precedingDocNo: input.preceding?.docNo || null,
    precedingDocDate: input.preceding?.docDate || null,
    sellerGstin,
    sellerName: clean(input.seller.legalName) || null,
    sellerAddr1, sellerAddr2,
    sellerPlace: clean(input.seller.place) || null,
    sellerPincode: clean(input.seller.pincode) || null,
    sellerStateCode: sellerState || null,
    buyerGstin,
    buyerName: clean(input.buyer.name) || null,
    buyerAddr1, buyerAddr2,
    buyerPlace: clean(input.buyer.place) || null,
    buyerPincode: buyerPincode || null,
    buyerStateCode: buyerState || null,
    placeOfSupply: pos || null,
    hasShipTo: shipDiffers,
    shipToGstin: shipDiffers ? (normalizeGstin(ship?.gstin) || null) : null,
    shipToName: shipDiffers ? (clean(ship?.name) || clean(input.buyer.name) || null) : null,
    shipToAddr1: shipAddr1, shipToAddr2: shipAddr2,
    shipToPlace: shipDiffers ? (clean(ship?.place) || null) : null,
    shipToPincode: shipDiffers ? (clean(ship?.pincode) || null) : null,
    shipToStateCode: shipDiffers ? (clean(ship?.stateCode) || stateCodeOfGstin(ship?.gstin) || null) : null,
    taxableValue, cgstValue, sgstValue, igstValue, cessValue, discountValue, otherCharges: 0, roundOff, totalValue,
  };

  const warnings: string[] = [];
  if (isExport) warnings.push('Export supply: sent as with/without payment of tax from the tax charged on the invoice. Change the supply type if a LUT or bond applies');
  if (isSez) warnings.push(`SEZ supply: sent as ${supplyType} from the tax charged. Choose SEZWPNA if the SEZ unit has not authorized payment of tax`);
  const errors = validateEInvoice(einvoice, items, input.rule || null, isExport);
  return { einvoice, items, errors, warnings, interState };
}

type Validatable = Record<string, any>;

// Everything the portal would reject, checked before the file is exported.
export function validateEInvoice(e: Validatable, items: EInvoiceItemDraft[], rule: Pick<RuleVersion, 'maxDocNoLength' | 'shipToGstinMandatoryFrom'> | null = null, isExport = false): string[] {
  const errors: string[] = [];
  const num = (value: any) => Number(value?.toString?.() ?? value ?? 0);
  const docDate = e.docDate instanceof Date ? e.docDate : new Date(e.docDate);

  const docNoProblem = validateDocNo(e.docNo, rule?.maxDocNoLength || 16);
  if (docNoProblem) errors.push(docNoProblem);
  if (Number.isNaN(docDate.getTime())) errors.push('Document date is not valid');
  else if (docDate.getTime() > Date.now() + 24 * 3600 * 1000) errors.push('Document date cannot be in the future');
  else if (docDate.getTime() < EARLIEST_DOC_DATE.getTime()) errors.push('The portal accepts e-invoices only for documents dated 1 April 2025 or later');
  if (!(SUPPLY_TYPES as readonly string[]).includes(e.supplyType)) errors.push(`Supply type "${e.supplyType}" is not one the portal accepts (${SUPPLY_TYPES.join(', ')})`);
  const isSezSupply = String(e.supplyType || '').startsWith('SEZ');
  if (!['INV', 'CRN', 'DBN'].includes(e.docType)) errors.push('Document type must be INV, CRN or DBN');
  if (e.docType !== 'INV' && (!e.precedingDocNo || !e.precedingDocDate)) errors.push('A credit or debit note must refer to the original invoice number and date');

  // Seller
  if (!isValidGstin(e.sellerGstin)) errors.push('Seller GSTIN is missing or not a valid GSTIN');
  else if (e.sellerStateCode && stateCodeOfGstin(e.sellerGstin) !== e.sellerStateCode) errors.push(`Seller GSTIN belongs to state ${stateCodeOfGstin(e.sellerGstin)} but the seller state code is ${e.sellerStateCode}`);
  if (!e.sellerName || e.sellerName.length < 3) errors.push('Seller legal name is missing (set the company legal name)');
  if (!e.sellerAddr1) errors.push('Seller address is missing');
  if (!e.sellerPlace || e.sellerPlace.length < 3) errors.push('Seller place/city is missing (at least 3 characters)');
  if (!e.sellerPincode || !PINCODE_PATTERN.test(e.sellerPincode)) errors.push('Seller pincode is missing or not a valid 6-digit pincode');
  if (!e.sellerStateCode || !STATE_CODES[e.sellerStateCode]) errors.push('Seller state code is missing or invalid');

  // Buyer
  if (!isExport) {
    if (!e.buyerGstin) errors.push('Buyer has no GSTIN: only B2B documents are reported as e-invoices');
    else if (!isValidGstin(e.buyerGstin)) errors.push(`Buyer GSTIN "${e.buyerGstin}" is not a valid GSTIN`);
    else if (e.buyerStateCode && stateCodeOfGstin(e.buyerGstin) !== e.buyerStateCode) errors.push(`Buyer GSTIN belongs to state ${stateCodeOfGstin(e.buyerGstin)} but the buyer state code is ${e.buyerStateCode}`);
    if (!e.buyerStateCode || !STATE_CODES[e.buyerStateCode]) errors.push('Buyer state code is missing or invalid');
    if (!e.buyerPincode || !PINCODE_PATTERN.test(e.buyerPincode)) errors.push('Buyer pincode is missing or not a valid 6-digit pincode');
  }
  if (!e.buyerName || e.buyerName.length < 3) errors.push('Buyer legal name is missing (at least 3 characters)');
  if (!e.buyerAddr1) errors.push('Buyer address is missing');
  if (!e.buyerPlace || e.buyerPlace.length < 3) errors.push('Buyer place/city is missing (at least 3 characters)');
  if (!e.placeOfSupply || (!STATE_CODES[e.placeOfSupply] && e.placeOfSupply !== EXPORT_STATE_CODE && e.placeOfSupply !== OTHER_COUNTRY_STATE_CODE)) errors.push('Place of supply is missing or not a valid state code');

  // Ship-to
  const shipProblem = validateShipToGstin({ shipToGstin: e.shipToGstin, docDate, rule, hasShipToParty: Boolean(e.hasShipTo) });
  if (shipProblem) errors.push(shipProblem);
  if (e.hasShipTo) {
    // GSTN advisory of 17 Jun 2026: the same GSTIN cannot be used for both bill-to and ship-to.
    if (e.shipToGstin && e.buyerGstin && e.shipToGstin === e.buyerGstin) errors.push('Ship-to GSTIN is the same as the buyer GSTIN. If the goods go to the buyer at its own address, untick "shipped to a different place"; otherwise enter the GSTIN of the place the goods go to (or URP)');
    if (e.shipToGstin && e.shipToStateCode && isValidGstin(e.shipToGstin) && stateCodeOfGstin(e.shipToGstin) !== e.shipToStateCode) errors.push(`Ship-to GSTIN belongs to state ${stateCodeOfGstin(e.shipToGstin)} but the ship-to state code is ${e.shipToStateCode}`);
    if (!e.shipToAddr1) errors.push('Ship-to address is missing');
    if (!e.shipToPlace || e.shipToPlace.length < 3) errors.push('Ship-to place/city is missing (at least 3 characters)');
    if (!e.shipToPincode || !PINCODE_PATTERN.test(e.shipToPincode)) errors.push('Ship-to pincode is missing or not a valid 6-digit pincode');
    if (!e.shipToStateCode || !STATE_CODES[e.shipToStateCode]) errors.push('Ship-to state code is missing or invalid');
  }

  // Lines
  if (!items.length) errors.push('The document has no lines');
  if (items.length > MAX_LINES) errors.push(`The portal accepts at most ${MAX_LINES} lines; this document has ${items.length}`);
  const interState = isExport || isSezSupply || (!!e.sellerStateCode && !!e.placeOfSupply && e.sellerStateCode !== e.placeOfSupply);
  items.forEach((item) => {
    const where = `Line ${item.slNo} (${item.productName})`;
    if (!HSN_PATTERN.test(item.hsnCode)) errors.push(`${where}: HSN/SAC code must be 4, 6 or 8 digits`);
    if (!item.unit || !VALID_UQC.has(item.unit)) errors.push(`${where}: unit "${item.unit || ''}" is not a valid unit quantity code (set the product unit)`);
    if (!(item.quantity > 0)) errors.push(`${where}: quantity must be greater than zero`);
    if (item.unitPrice < 0 || item.taxableAmount < 0) errors.push(`${where}: amounts cannot be negative`);
    if (!isExport && interState && (item.cgstAmount > 0 || item.sgstAmount > 0)) errors.push(`${where}: CGST/SGST is charged on a supply to another state (should be IGST)`);
    if (!isExport && !interState && item.igstAmount > 0) errors.push(`${where}: IGST is charged on a supply within the same state (should be CGST and SGST)`);
  });

  // Totals
  const lineSum = round2(items.reduce((total, item) => total + item.totalItemValue, 0));
  const expected = round2(lineSum - num(e.discountValue) + num(e.otherCharges) + num(e.roundOff));
  if (Math.abs(expected - num(e.totalValue)) > 0.01) errors.push(`Document total ${num(e.totalValue).toFixed(2)} does not match the lines (${expected.toFixed(2)})`);
  if (Math.abs(num(e.roundOff)) > MAX_ROUND_OFF) errors.push(`Document total differs from the line values by ${num(e.roundOff).toFixed(2)}, more than the portal's round-off limit; check the tax on the document`);
  return errors;
}

// ---- portal file ----------------------------------------------------------------------------------------------

// DD/MM/YYYY in Indian time, the format the portal uses.
export function formatIrpDate(value: Date | string) {
  const date = new Date(new Date(value).getTime() + 5.5 * 3600 * 1000);
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

const trim = (value: any, max: number) => (value == null || value === '' ? undefined : String(value).slice(0, max));
const amount = (value: any) => round2(Number(value?.toString?.() ?? value ?? 0));
// Quantity, unit price and rates carry up to 3 decimals on the portal.
const round3n = (value: any) => round3(Number(value?.toString?.() ?? value ?? 0));

export function toIrpInvoice(e: Record<string, any>, items: Array<Record<string, any>>, schemaVersion: string = IRP_SCHEMA_VERSION) {
  const party = (gstin: any, name: any, addr1: any, addr2: any, place: any, pincode: any, state: any) => ({
    Gstin: gstin || undefined, LglNm: trim(name, 100), Addr1: trim(addr1, 100), Addr2: trim(addr2, 100), Loc: trim(place, 50), Pin: Number(pincode), Stcd: String(state || ''),
  });
  const entry: Record<string, any> = {
    Version: schemaVersion,
    TranDtls: { TaxSch: 'GST', SupTyp: e.supplyType, RegRev: e.reverseCharge ? 'Y' : 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: e.docType, No: e.docNo, Dt: formatIrpDate(e.docDate) },
    SellerDtls: party(e.sellerGstin, e.sellerName, e.sellerAddr1, e.sellerAddr2, e.sellerPlace, e.sellerPincode, e.sellerStateCode),
    BuyerDtls: { ...party(e.buyerGstin, e.buyerName, e.buyerAddr1, e.buyerAddr2, e.buyerPlace, e.buyerPincode, e.buyerStateCode), Pos: String(e.placeOfSupply || '') },
    ItemList: items.map((item) => {
      const gstRate = round2(Number(item.cgstRate || 0) + Number(item.sgstRate || 0) + Number(item.igstRate || 0));
      return {
        SlNo: String(item.slNo),
        PrdDesc: trim(item.description || item.productName, 300),
        IsServc: item.isService ? 'Y' : 'N',
        HsnCd: String(item.hsnCode),
        Qty: round3n(item.quantity),
        Unit: item.unit,
        UnitPrice: round3n(item.unitPrice),
        TotAmt: amount(item.grossAmount),
        Discount: amount(item.discount),
        AssAmt: amount(item.taxableAmount),
        GstRt: round3(gstRate),
        IgstAmt: amount(item.igstAmount),
        CgstAmt: amount(item.cgstAmount),
        SgstAmt: amount(item.sgstAmount),
        CesRt: round3n(item.cessRate || 0),
        CesAmt: amount(item.cessAmount),
        TotItemVal: amount(item.totalItemValue),
      };
    }),
    ValDtls: {
      AssVal: amount(e.taxableValue), CgstVal: amount(e.cgstValue), SgstVal: amount(e.sgstValue), IgstVal: amount(e.igstValue), CesVal: amount(e.cessValue),
      Discount: amount(e.discountValue), OthChrg: amount(e.otherCharges), RndOffAmt: amount(e.roundOff), TotInvVal: amount(e.totalValue),
    },
  };
  if (e.hasShipTo) entry.ShipDtls = party(e.shipToGstin, e.shipToName, e.shipToAddr1, e.shipToAddr2, e.shipToPlace, e.shipToPincode, e.shipToStateCode);
  if (e.docType !== 'INV' && e.precedingDocNo) entry.RefDtls = { PrecDocDtls: [{ InvNo: e.precedingDocNo, InvDt: formatIrpDate(e.precedingDocDate) }] };
  const strip = (value: any): any => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, strip(v)]));
    return value;
  };
  return strip(entry);
}

// The bulk-upload file is a list of invoices. (confirm against the portal's bulk generation sample)
export function buildIrpBulkFile(entries: Array<Record<string, any>>) {
  return entries;
}
