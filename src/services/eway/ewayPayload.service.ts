import {
  EXPORT_PINCODE, HSN_PATTERN, MAX_DISTANCE_KM, OTHER_COUNTRY_STATE_CODE, PINCODE_PATTERN, STATE_CODES, TRANSPORT_MODES, VEHICLE_PATTERN,
  GSTIN_PATTERN, isValidGstin, normalizeGstin, normalizeVehicleNo, stateCodeOfGstin, uqcFor,
} from './ewayRules.service';

// Pure functions: they take plain data and return plain data, so they are unit tested without a database.

export type EwayLineInput = {
  productId?: string | null;
  productName: string;
  description?: string | null;
  hsnCode?: string | null;
  unitSymbol?: string | null;
  quantity: number;
  taxableAmount: number;
  taxRate: number;
  // Item tax rows as stored on the invoice, used to split the rate into CGST/SGST/IGST/Cess.
  taxes?: Array<{ label: string; rate: number }>;
};

export type EwayBuildInput = {
  sourceType: 'SALES_INVOICE' | 'DELIVERY_NOTE';
  doc: { docNo: string; docDate: Date; grandTotal?: number | null };
  dispatch: { gstin: string; legalName?: string | null };
  from: { addr1?: string | null; addr2?: string | null; place?: string | null; pincode?: string | null; stateCode?: string | null };
  customer: { name: string; gstin?: string | null; stateCode?: string | null; country?: string | null };
  shipTo: { addr1?: string | null; addr2?: string | null; place?: string | null; pincode?: string | null; stateCode?: string | null };
  lines: EwayLineInput[];
  transport: {
    mode?: string | null; distanceKm?: number | null; transporterId?: string | null; transporterName?: string | null;
    transportDocNo?: string | null; transportDocDate?: Date | null; vehicleNo?: string | null; vehicleType?: string | null;
  };
  overrides?: { subSupplyType?: number; transactionType?: number; actualFromStateCode?: string | null; actualToStateCode?: string | null };
};

export type EwayItemDraft = {
  productId: string | null; productName: string; description: string | null; hsnCode: string; quantity: number; qtyUnit: string;
  taxableAmount: number; cgstRate: number; sgstRate: number; igstRate: number; cessRate: number;
};

export type EwayDraft = ReturnType<typeof buildEwayDraft>['bill'];

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function classifyLabel(label: string): 'cgst' | 'sgst' | 'igst' | 'cess' | null {
  const text = label.toLowerCase();
  if (/\bigst\b|integrated/.test(text)) return 'igst';
  if (/\bcgst\b|central/.test(text)) return 'cgst';
  if (/\bsgst\b|\butgst\b|state\s*(gst|tax)/.test(text)) return 'sgst';
  if (/\bcess\b/.test(text)) return 'cess';
  return null;
}

// Splits a line's tax into the four GST components. Uses the stored tax rows when their labels are
// recognisable, otherwise falls back to the plain rate and the supply direction (intra vs inter state).
export function splitLineTax(line: EwayLineInput, interState: boolean) {
  const rates = { cgst: 0, sgst: 0, igst: 0, cess: 0 };
  let recognised = 0;
  for (const tax of line.taxes || []) {
    const kind = classifyLabel(tax.label || '');
    if (!kind) continue;
    rates[kind] += Number(tax.rate) || 0;
    recognised += 1;
  }
  if (!recognised && Number(line.taxRate) > 0) {
    if (interState) rates.igst = Number(line.taxRate);
    else { rates.cgst = Number(line.taxRate) / 2; rates.sgst = Number(line.taxRate) / 2; }
  }
  return rates;
}

function splitAddress(text?: string | null): [string | null, string | null] {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return [null, null];
  if (value.length <= 120) return [value, null];
  const cut = value.lastIndexOf(',', 120) > 60 ? value.lastIndexOf(',', 120) : 120;
  return [value.slice(0, cut).trim(), value.slice(cut).replace(/^,/, '').trim().slice(0, 120)];
}

export function buildEwayDraft(input: EwayBuildInput) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const dispatchGstin = normalizeGstin(input.dispatch.gstin);
  const fromStateCode = input.from.stateCode || stateCodeOfGstin(dispatchGstin) || '';
  const customerGstin = normalizeGstin(input.customer.gstin);
  const country = String(input.customer.country || 'India').trim().toUpperCase();
  const isExport = !['INDIA', 'IN', ''].includes(country);

  let toGstin = isValidGstin(customerGstin) ? customerGstin : 'URP';
  // Bill-to state: from the recipient's GSTIN when registered, otherwise from the customer/ship-to address.
  let toStateCode = stateCodeOfGstin(toGstin) || input.customer.stateCode || input.shipTo.stateCode || '';
  let actualToStateCode = input.shipTo.stateCode || toStateCode;
  let toPincode = String(input.shipTo.pincode || '').trim();
  if (isExport) { toGstin = 'URP'; toStateCode = OTHER_COUNTRY_STATE_CODE; actualToStateCode = OTHER_COUNTRY_STATE_CODE; toPincode = EXPORT_PINCODE; }

  const interState = isExport || (!!fromStateCode && !!toStateCode && fromStateCode !== toStateCode);

  // The portal allows a delivery challan only under the sub supply type "Others" and needs zero tax on it (NIC
  // Table 2 and validation 14). A bill made from a delivery note is that case; a bill for goods that are being
  // sold should be made from the invoice instead.
  const isChallan = input.sourceType === 'DELIVERY_NOTE';
  if (isChallan) warnings.push('Delivery challan bill: the portal requires sub supply type "Others" and zero tax on a challan, so no tax is shown. If these goods are being sold, make the e-way bill from the invoice');

  const items: EwayItemDraft[] = input.lines.map((line) => {
    const rates = isChallan ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : splitLineTax(line, interState);
    return {
      productId: line.productId || null,
      productName: line.productName,
      description: line.description || null,
      hsnCode: String(line.hsnCode || '').replace(/\s+/g, ''),
      quantity: Number(line.quantity),
      qtyUnit: uqcFor(line.unitSymbol) || '',
      taxableAmount: round2(Number(line.taxableAmount)),
      cgstRate: rates.cgst, sgstRate: rates.sgst, igstRate: rates.igst, cessRate: rates.cess,
    };
  });

  const sum = (pick: (item: EwayItemDraft) => number) => round2(items.reduce((total, item) => total + pick(item), 0));
  const taxableValue = sum((i) => i.taxableAmount);
  const cgstValue = sum((i) => round2(i.taxableAmount * i.cgstRate / 100));
  const sgstValue = sum((i) => round2(i.taxableAmount * i.sgstRate / 100));
  const igstValue = sum((i) => round2(i.taxableAmount * i.igstRate / 100));
  const cessValue = sum((i) => round2(i.taxableAmount * i.cessRate / 100));
  const taxTotal = round2(cgstValue + sgstValue + igstValue + cessValue);
  const computedTotal = round2(taxableValue + taxTotal);
  // A challan carries no tax, so an invoice-style document total must not turn the tax back into "other value".
  const grandTotal = isChallan || input.doc.grandTotal == null ? null : round2(Number(input.doc.grandTotal));
  // Round-off, freight or an invoice-level discount: whatever separates the line values from the document total.
  const otherValue = grandTotal == null ? 0 : round2(grandTotal - computedTotal);
  const totalValue = grandTotal == null ? computedTotal : grandTotal;

  const [fromAddr1, fromAddr2] = input.from.addr2 ? [String(input.from.addr1 || '').slice(0, 120) || null, String(input.from.addr2).slice(0, 120)] : splitAddress(input.from.addr1);
  const [toAddr1, toAddr2] = input.shipTo.addr2 ? [String(input.shipTo.addr1 || '').slice(0, 120) || null, String(input.shipTo.addr2).slice(0, 120)] : splitAddress(input.shipTo.addr1);
  const mode = String(input.transport.mode || 'ROAD').toUpperCase();

  const bill = {
    sourceType: input.sourceType,
    supplyType: 'O',
    subSupplyType: input.overrides?.subSupplyType ?? (isChallan ? 8 : isExport ? 3 : 1),
    docType: input.sourceType === 'SALES_INVOICE' ? 'INV' : 'CHL',
    docNo: input.doc.docNo,
    docDate: input.doc.docDate,
    transactionType: input.overrides?.transactionType ?? (toStateCode && actualToStateCode && toStateCode !== actualToStateCode ? 2 : 1),
    dispatchGstin,
    fromGstin: dispatchGstin,
    fromName: input.dispatch.legalName || null,
    fromAddr1, fromAddr2,
    fromPlace: input.from.place || null,
    fromPincode: String(input.from.pincode || '').trim() || null,
    fromStateCode: fromStateCode || null,
    actualFromStateCode: input.overrides?.actualFromStateCode || fromStateCode || null,
    toGstin,
    toName: input.customer.name,
    toAddr1, toAddr2,
    toPlace: input.shipTo.place || null,
    toPincode: toPincode || null,
    toStateCode: toStateCode || null,
    actualToStateCode: input.overrides?.actualToStateCode || actualToStateCode || null,
    taxableValue, cgstValue, sgstValue, igstValue, cessValue, otherValue, totalValue,
    transportMode: mode,
    distanceKm: Math.max(0, Math.round(Number(input.transport.distanceKm) || 0)),
    transporterId: normalizeGstin(input.transport.transporterId) || null,
    transporterName: input.transport.transporterName?.trim() || null,
    transportDocNo: input.transport.transportDocNo?.trim() || null,
    transportDocDate: input.transport.transportDocDate || null,
    vehicleNo: normalizeVehicleNo(input.transport.vehicleNo) || null,
    vehicleType: String(input.transport.vehicleType || 'R').toUpperCase(),
  };

  errors.push(...validateEwayBill(bill, items));
  if (otherValue !== 0 && Math.abs(otherValue) > Math.max(1, taxableValue * 0.01)) warnings.push(`Document total differs from the line values by ${otherValue.toFixed(2)} (round-off, freight or discount); sent as "other value"`);
  return { bill, items, errors, warnings, interState };
}

type ValidatableBill = ReturnType<typeof buildEwayDraft>['bill'] | Record<string, any>;

// Everything the NIC would reject, checked before the file is exported.
export function validateEwayBill(bill: ValidatableBill, items: EwayItemDraft[]): string[] {
  const errors: string[] = [];
  const b = bill as any;
  if (!isValidGstin(b.dispatchGstin)) errors.push('Dispatch GSTIN is missing or not a valid GSTIN');
  else if (b.fromStateCode && stateCodeOfGstin(b.dispatchGstin) !== b.fromStateCode) errors.push(`Dispatch GSTIN belongs to state ${stateCodeOfGstin(b.dispatchGstin)} but the dispatch warehouse is in state ${b.fromStateCode}`);
  if (!b.fromStateCode || !STATE_CODES[b.fromStateCode]) errors.push('Dispatch state code is missing or invalid (set it on the warehouse)');
  if (!b.fromPincode || !PINCODE_PATTERN.test(b.fromPincode)) errors.push('Dispatch pincode is missing or invalid (set it on the warehouse)');
  if (!b.fromAddr1) errors.push('Dispatch address is missing');
  if (!b.toName) errors.push('Recipient name is missing');
  if (b.toGstin !== 'URP' && !GSTIN_PATTERN.test(b.toGstin)) errors.push('Recipient GSTIN is not valid');
  if (!b.toStateCode || !STATE_CODES[b.toStateCode]) errors.push('Delivery state is missing or invalid (set the state/state code on the customer or shipping address)');
  if (!b.toPincode || !(PINCODE_PATTERN.test(b.toPincode))) errors.push('Delivery pincode is missing or invalid');
  if (!b.toAddr1) errors.push('Delivery address is missing');
  if (!b.docNo) errors.push('Document number is missing');
  if (!items.length) errors.push('There are no line items');

  const modeNumber = TRANSPORT_MODES[String(b.transportMode)];
  if (!modeNumber) errors.push('Transport mode must be ROAD, RAIL, AIR or SHIP');
  if (!Number.isFinite(b.distanceKm) || b.distanceKm < 0 || b.distanceKm > MAX_DISTANCE_KM) errors.push(`Distance must be between 0 and ${MAX_DISTANCE_KM} km (0 lets the portal calculate it from the pincodes)`);
  if (b.transporterId && !/^[0-9A-Z]{15}$/.test(b.transporterId)) errors.push('Transporter ID must be a 15-character GSTIN/TRANSIN');
  if (modeNumber === 1) {
    if (!b.vehicleNo && !b.transporterId) errors.push('Enter the vehicle number or the transporter ID (Part B)');
    if (b.vehicleNo && !VEHICLE_PATTERN.test(b.vehicleNo)) errors.push('Vehicle number format is not valid (example MH12AB1234)');
    if (!['R', 'O'].includes(b.vehicleType)) errors.push('Vehicle type must be R (regular) or O (over-dimensional cargo)');
  } else if (modeNumber) {
    if (!b.transportDocNo) errors.push('Transport document number is required for rail, air and ship');
    if (!b.transportDocDate) errors.push('Transport document date is required for rail, air and ship');
  }
  if (b.subSupplyType === 3 && b.toStateCode !== OTHER_COUNTRY_STATE_CODE) errors.push('Export supplies must use state code 99 (other country)');

  items.forEach((item, index) => {
    const label = `Item ${index + 1} (${item.productName})`;
    if (!HSN_PATTERN.test(item.hsnCode)) errors.push(`${label}: HSN must be 4, 6 or 8 digits`);
    if (!item.qtyUnit) errors.push(`${label}: unit is missing or has no matching UQC code`);
    if (!(item.quantity > 0)) errors.push(`${label}: quantity must be above zero`);
    if (!(item.taxableAmount >= 0)) errors.push(`${label}: taxable amount is invalid`);
    const interState = b.fromStateCode !== b.toStateCode;
    if (interState && (item.cgstRate > 0 || item.sgstRate > 0)) errors.push(`${label}: CGST/SGST cannot be used on an inter-state supply; the invoice tax must be IGST`);
    if (!interState && item.igstRate > 0) errors.push(`${label}: IGST cannot be used on an intra-state supply; the invoice tax must be CGST + SGST`);
  });
  return errors;
}

export function formatNicDate(value: Date) {
  // The portal wants dd/MM/yyyy in Indian time.
  const ist = new Date(new Date(value).getTime() + 5.5 * 3600 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${ist.getUTCFullYear()}`;
}

const trim = (value: string | null | undefined, max: number) => (value ? String(value).slice(0, max) : undefined);
const num = (value: any) => round2(Number(value) || 0);

// One entry of the NIC bulk-upload file ("billLists"). Field names follow the NIC EWB JSON attributes and sample
// file (version 1.0.0621), which spell a few keys differently from the portal's web form: transType, OthValue,
// TotNonAdvolVal, and hsnCode as text.
export function toNicBill(bill: Record<string, any>, items: Array<Record<string, any>>) {
  const modeNumber = TRANSPORT_MODES[String(bill.transportMode)] || 1;
  const totalDocQty = items.reduce((sum: number, it: any) => sum + Number(it.quantity || 0), 0);
  const isSplit = bill.splitQuantity != null && Number(bill.splitQuantity) > 0 && totalDocQty > 0;
  const ratio = isSplit ? Number(bill.splitQuantity) / totalDocQty : 1;
  const entry: Record<string, any> = {
    userGstin: bill.dispatchGstin,
    supplyType: bill.supplyType,
    subSupplyType: bill.subSupplyType,
    // Mandatory when the sub supply type is Others (8).
    subSupplyDesc: bill.subSupplyType === 8 ? (bill.docType === 'CHL' ? 'Delivery challan' : 'Others') : undefined,
    docType: bill.docType,
    docNo: bill.docNo,
    docDate: formatNicDate(bill.docDate),
    transType: bill.transactionType,
    fromGstin: bill.fromGstin,
    fromTrdName: trim(bill.fromName, 100),
    fromAddr1: trim(bill.fromAddr1, 120),
    fromAddr2: trim(bill.fromAddr2, 120),
    fromPlace: trim(bill.fromPlace, 50),
    fromPincode: Number(bill.fromPincode),
    fromStateCode: Number(bill.fromStateCode),
    actualFromStateCode: Number(bill.actualFromStateCode || bill.fromStateCode),
    toGstin: bill.toGstin,
    toTrdName: trim(bill.toName, 100),
    toAddr1: trim(bill.toAddr1, 120),
    toAddr2: trim(bill.toAddr2, 120),
    toPlace: trim(bill.toPlace, 50),
    toPincode: Number(bill.toPincode),
    toStateCode: Number(bill.toStateCode),
    actualToStateCode: Number(bill.actualToStateCode || bill.toStateCode),
    totalValue: round2(num(bill.taxableValue) * ratio),
    cgstValue: round2(num(bill.cgstValue) * ratio),
    sgstValue: round2(num(bill.sgstValue) * ratio),
    igstValue: round2(num(bill.igstValue) * ratio),
    cessValue: round2(num(bill.cessValue) * ratio),
    TotNonAdvolVal: 0,
    OthValue: round2(num(bill.otherValue) * ratio),
    totInvValue: round2(num(bill.totalValue) * ratio),
    transMode: modeNumber,
    transDistance: Number(bill.distanceKm) || 0,
    mainHsnCode: items[0]?.hsnCode ? String(items[0].hsnCode) : undefined,
    itemList: items.map((item, index) => ({
      itemNo: index + 1,
      productName: trim(item.productName, 100),
      productDesc: trim(item.description || item.productName, 100),
      hsnCode: String(item.hsnCode),
      quantity: isSplit ? round2(Number(item.quantity) * ratio) : Number(item.quantity),
      qtyUnit: item.qtyUnit,
      taxableAmount: isSplit ? round2(num(item.taxableAmount) * ratio) : num(item.taxableAmount),
      sgstRate: Number(item.sgstRate) || 0,
      cgstRate: Number(item.cgstRate) || 0,
      igstRate: Number(item.igstRate) || 0,
      cessRate: Number(item.cessRate) || 0,
      cessNonAdvol: 0,
    })),
  };
  if (bill.transporterName) entry.transporterName = trim(bill.transporterName, 25);
  if (bill.transporterId) entry.transporterId = bill.transporterId;
  if (bill.transportDocNo) entry.transDocNo = trim(bill.transportDocNo, 15);
  if (bill.transportDocDate) entry.transDocDate = formatNicDate(bill.transportDocDate);
  if (bill.vehicleNo) { entry.vehicleNo = bill.vehicleNo; entry.vehicleType = bill.vehicleType; }
  for (const key of Object.keys(entry)) if (entry[key] === undefined || entry[key] === null) delete entry[key];
  return entry;
}

export const NIC_BULK_VERSION = '1.0.0621';

export function buildNicBulkFile(entries: Array<Record<string, any>>) {
  return { version: NIC_BULK_VERSION, billLists: entries };
}
