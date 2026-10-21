import { buildEwayDraft, buildNicBulkFile, round2, toNicBill, validateEwayBill, type EwayBuildInput, type EwayLineInput } from './ewayPayload.service';
import {
  DEFAULT_VALUE_THRESHOLD, EWB_NUMBER_PATTERN, VEHICLE_PATTERN, canCancelOnPortal, isEwayRequired, isValidGstin, normalizeGstin, normalizeVehicleNo,
  stateCodeFromName, stateCodeOfGstin, suggestedValidUntil, uqcFor,
} from './ewayRules.service';
import { audit } from '../../utils/erp';
import { allocateDocumentNo } from '../../utils/generate';
import { currentCompanyId } from '../../utils/tenant';

// Database side of the e-way bill. Manual mode: the ERP prepares and validates the bill, exports the NIC bulk
// upload file, and the user records the number the portal returns. Everything is done inside the caller's
// transaction (tx) so the bill, its events and the audit row commit together.

export type SourceType = 'SALES_INVOICE' | 'DELIVERY_NOTE';
const LIVE_STATUSES = ['DRAFT', 'EXPORTED', 'GENERATED', 'EXPIRED'];

export class EwayError extends Error {
  constructor(message: string, public status = 400, public details?: string[]) { super(message); }
}

const num = (value: any) => Number(value?.toString?.() ?? value ?? 0);

export async function getConfig(tx: any) {
  const existing = await tx.ewayBillConfig.findFirst({});
  if (existing) return existing;
  return tx.ewayBillConfig.create({ data: { companyId: currentCompanyId() } });
}

export async function updateConfig(tx: any, req: any, input: any) {
  const current = await getConfig(tx);
  const data: any = {};
  if (input.valueThreshold !== undefined) {
    if (!(Number(input.valueThreshold) >= 0)) throw new EwayError('Value threshold must be zero or more');
    data.valueThreshold = Number(input.valueThreshold);
  }
  if (input.defaultTransportMode !== undefined) {
    if (!['ROAD', 'RAIL', 'AIR', 'SHIP'].includes(input.defaultTransportMode)) throw new EwayError('Transport mode must be ROAD, RAIL, AIR or SHIP');
    data.defaultTransportMode = input.defaultTransportMode;
  }
  if (input.defaultTransporterId !== undefined) data.defaultTransporterId = normalizeGstin(input.defaultTransporterId) || null;
  if (input.defaultTransporter !== undefined) data.defaultTransporter = input.defaultTransporter || null;
  if (input.hardBlockOnDispatch !== undefined) data.hardBlockOnDispatch = Boolean(input.hardBlockOnDispatch);
  // Only MANUAL exists until a GSP integration is built; API mode is rejected rather than silently ignored.
  if (input.mode !== undefined && input.mode !== 'MANUAL') throw new EwayError('Only MANUAL mode is available; API mode needs a GSP integration');
  const updated = await tx.ewayBillConfig.update({ where: { id: current.id }, data });
  await audit(tx, req, { entityType: 'EWAY_BILL_CONFIG', entityId: updated.id, action: 'UPDATE', message: 'Updated e-way bill settings' });
  return updated;
}

// GSTINs the company can dispatch from: the company registration, its per-state registrations and branch GSTINs.
export async function dispatchGstinOptions(tx: any) {
  const companyId = currentCompanyId();
  const options = new Map<string, any>();
  const add = (gstin: string | null | undefined, extra: any) => {
    const value = normalizeGstin(gstin);
    if (!isValidGstin(value) || options.has(value)) return;
    options.set(value, { gstin: value, stateCode: stateCodeOfGstin(value), ...extra });
  };
  const company = companyId ? await tx.company.findUnique({ where: { id: companyId } }) : await tx.company.findFirst({});
  if (company) add(company.gstin, { source: 'COMPANY', legalName: company.legalName || company.name, address: { address: company.address, city: company.city, state: company.state, pincode: company.zip } });
  const registrations = await tx.companyGstin.findMany({ where: { isActive: true }, orderBy: [{ isDefault: 'desc' }, { stateCode: 'asc' }] });
  for (const row of registrations) add(row.gstin, { source: 'REGISTRATION', legalName: row.legalName || company?.legalName || company?.name, address: row.address });
  const branches = await tx.branch.findMany({ where: { isActive: true, gstin: { not: null } } });
  for (const row of branches) add(row.gstin, { source: 'BRANCH', legalName: company?.legalName || company?.name, branchName: row.name, address: row.address });
  return [...options.values()];
}

async function liveBillFor(tx: any, where: any) {
  return tx.ewayBill.findFirst({ where: { ...where, status: { in: LIVE_STATUSES } }, orderBy: { createdAt: 'desc' } });
}

// A document and its sibling (the invoice made from a delivery note, or the delivery note behind an invoice)
// describe the same consignment, so a live bill on either blocks a second bill.
async function siblingLiveBill(tx: any, sourceType: SourceType, source: any) {
  const own = await liveBillFor(tx, sourceType === 'SALES_INVOICE' ? { salesInvoiceId: source.id } : { deliveryNoteId: source.id });
  if (own) return own;
  if (sourceType === 'SALES_INVOICE' && source.deliveryNoteId) return liveBillFor(tx, { deliveryNoteId: source.deliveryNoteId });
  if (sourceType === 'DELIVERY_NOTE') {
    const invoices = await tx.salesInvoice.findMany({ where: { deliveryNoteId: source.id, status: { not: 'CANCELLED' } }, select: { id: true } });
    if (invoices.length) return liveBillFor(tx, { salesInvoiceId: { in: invoices.map((i: any) => i.id) } });
  }
  return null;
}

const productSelect = { select: { id: true, sku: true, name: true, type: true, hsnCode: true, unit: { select: { symbol: true, name: true } } } };

async function loadSource(tx: any, sourceType: SourceType, id: string) {
  if (sourceType === 'SALES_INVOICE') {
    const invoice = await tx.salesInvoice.findUnique({
      where: { id },
      include: {
        customer: true,
        items: { include: { product: productSelect, uom: true, taxes: true } },
        salesOrder: { select: { id: true, sourceWarehouseId: true, shippingAddressSnapshot: true } },
        deliveryNote: { select: { id: true, warehouseId: true } },
      },
    });
    if (!invoice) throw new EwayError('Sales invoice not found', 404);
    if (invoice.status !== 'SUBMITTED') throw new EwayError('An e-way bill can only be made for a submitted invoice');
    return invoice;
  }
  const note = await tx.deliveryNote.findUnique({
    where: { id },
    include: { customer: true, items: { include: { product: productSelect } }, salesOrder: { include: { items: true } } },
  });
  if (!note) throw new EwayError('Delivery note not found', 404);
  if (note.status !== 'SUBMITTED') throw new EwayError('An e-way bill can only be made for a submitted delivery note');
  return note;
}

// Goods lines of the source with their taxable value and tax rates. Services never move, so they are left out.
function sourceLines(sourceType: SourceType, source: any) {
  const warnings: string[] = [];
  let hasServices = false;
  const lines: EwayLineInput[] = [];
  let goodsTotal = 0;
  let totalQuantity = 0;
  if (sourceType === 'SALES_INVOICE') {
    for (const item of source.items) {
      if (item.product?.type !== 'PRODUCT') { hasServices = true; continue; }
      const taxable = item.netAmount && num(item.netAmount) > 0 ? num(item.netAmount) : round2(num(item.quantity) * num(item.rate) * (1 - num(item.discount) / 100));
      goodsTotal += num(item.total) || taxable + num(item.taxAmount);
      const qty = num(item.quantity);
      totalQuantity += qty;
      lines.push({
        productId: item.productId, productName: item.product?.name || item.description || item.itemCode, description: item.description,
        hsnCode: item.hsnCode || item.product?.hsnCode, unitSymbol: item.uom?.symbol || item.product?.unit?.symbol || item.product?.unit?.name,
        quantity: qty, taxableAmount: taxable, taxRate: num(item.taxRate),
        taxes: (item.taxes || []).map((tax: any) => ({ label: tax.label, rate: num(tax.rate) })),
      });
    }
  } else {
    // A delivery note carries no prices, so values come from the sales order it was made from.
    const prices = new Map<string, any>((source.salesOrder?.items || []).map((item: any) => [item.productId, item]));
    for (const item of source.items) {
      if (item.product?.type !== 'PRODUCT') { hasServices = true; continue; }
      const price = prices.get(item.productId);
      if (!price) { warnings.push(`No sales order price for ${item.product?.name || item.productId}`); continue; }
      const quantity = num(item.quantity);
      totalQuantity += quantity;
      const taxable = round2(quantity * num(price.unitPrice) * (1 - num(price.discount) / 100));
      goodsTotal += taxable + round2(taxable * num(price.taxRate) / 100);
      lines.push({
        productId: item.productId, productName: item.product?.name || item.description || item.itemCode, description: item.description,
        hsnCode: item.product?.hsnCode, unitSymbol: item.product?.unit?.symbol || item.product?.unit?.name,
        quantity, taxableAmount: taxable, taxRate: num(price.taxRate),
      });
    }
    if (!source.salesOrder) warnings.push('This delivery note has no sales order, so it has no prices; make the e-way bill from the invoice instead');
  }
  if (hasServices) warnings.push('Service lines are not goods and were left out of the e-way bill');
  return { lines, hasServices, goodsTotal: round2(goodsTotal), totalQuantity: round2(totalQuantity), warnings };
}

function addressParts(snapshot: any, fallback: any) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const state = value.state || fallback?.state;
  return {
    addr1: value.address || fallback?.address || null,
    place: value.city || fallback?.city || null,
    pincode: String(value.zip || value.pincode || fallback?.zip || '').trim() || null,
    stateCode: stateCodeFromName(state) || value.stateCode || fallback?.stateCode || null,
  };
}

async function dispatchFrom(tx: any, gstinOption: any, warehouseId: string | null | undefined, overrides: any) {
  const warnings: string[] = [];
  const warehouse = warehouseId ? await tx.warehouse.findUnique({ where: { id: warehouseId } }) : null;
  const defaultWh = !warehouse ? (await tx.warehouse.findFirst({ where: { isDefault: true, isActive: true } }) || await tx.warehouse.findFirst({ where: { isActive: true } })) : null;
  const wh = warehouse || defaultWh;
  const registration = gstinOption.address && typeof gstinOption.address === 'object' ? gstinOption.address : {};
  const from = {
    addr1: overrides.fromAddr1 ?? wh?.address ?? registration.address ?? registration.line1 ?? null,
    addr2: overrides.fromAddr2 ?? null,
    place: overrides.fromPlace ?? wh?.city ?? registration.city ?? null,
    pincode: overrides.fromPincode ?? wh?.pincode ?? registration.pincode ?? registration.zip ?? null,
    stateCode: overrides.fromStateCode ?? wh?.stateCode ?? gstinOption.stateCode ?? (registration.state ? stateCodeFromName(registration.state) : null) ?? null,
  };
  if (wh && !wh.stateCode && !overrides.fromStateCode && !from.stateCode) warnings.push(`Warehouse ${wh.name} has no state code; the GSTIN state was assumed. Set it on the warehouse so the state check works`);
  return { from, warnings, warehouse: wh };
}

function transportInput(config: any, body: any = {}) {
  return {
    mode: body.transportMode || config.defaultTransportMode || 'ROAD',
    distanceKm: body.distanceKm,
    transporterId: body.transporterId ?? config.defaultTransporterId,
    transporterName: body.transporterName ?? config.defaultTransporter,
    transportDocNo: body.transportDocNo,
    transportDocDate: body.transportDocDate ? new Date(body.transportDocDate) : null,
    vehicleNo: body.vehicleNo,
    vehicleType: body.vehicleType,
  };
}

async function newBillNo(tx: any) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const billNo = await allocateDocumentNo('EWAY_BILL', 'EWB', 6, tx);
    if (!(await tx.ewayBill.findUnique({ where: { billNo }, select: { id: true } }))) return billNo;
  }
  throw new EwayError('Could not allocate an e-way bill number', 500);
}

export async function checkRequirement(tx: any, sourceType: SourceType, sourceId: string) {
  const source = await loadSource(tx, sourceType, sourceId).catch((err) => { if (err instanceof EwayError && err.status === 400) return null; throw err; });
  if (!source) return { required: false, state: 'NOT_AVAILABLE', reason: 'Document is not submitted', value: 0, totalQuantity: 0, threshold: DEFAULT_VALUE_THRESHOLD, bill: null, bills: [] };
  const config = await getConfig(tx);
  const threshold = num(config.valueThreshold);
  const { goodsTotal, lines, totalQuantity } = sourceLines(sourceType, source);
  const existing = await siblingLiveBill(tx, sourceType, source);
  const result = isEwayRequired({ totalValue: goodsTotal, threshold, hasGoods: lines.length > 0 });
  const state = existing ? 'HAS_BILL' : result.required ? 'REQUIRED_MISSING' : 'NOT_REQUIRED';

  const allBills = await tx.ewayBill.findMany({
    where: {
      status: { in: LIVE_STATUSES },
      ...(sourceType === 'SALES_INVOICE' ? { salesInvoiceId: source.id } : { deliveryNoteId: source.id }),
    },
    select: { id: true, billNo: true, status: true, ewbNo: true, vehicleNo: true, splitQuantity: true, splitGroupId: true },
    orderBy: { createdAt: 'asc' },
  });

  return {
    required: result.required, state, reason: result.reason, value: goodsTotal, totalQuantity, threshold,
    hardBlock: Boolean(config.hardBlockOnDispatch && result.required && !existing),
    bill: existing ? { id: existing.id, billNo: existing.billNo, status: existing.status, ewbNo: existing.ewbNo, validUntil: existing.validUntil } : null,
    bills: allBills,
  };
}

export async function createBill(tx: any, req: any, input: { sourceType: SourceType; sourceId: string; dispatchGstin: string; warehouseId?: string } & Record<string, any>) {
  if (!['SALES_INVOICE', 'DELIVERY_NOTE'].includes(input.sourceType)) throw new EwayError('sourceType must be SALES_INVOICE or DELIVERY_NOTE');
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `eway-create:${input.sourceType}:${input.sourceId}`);
  const source = await loadSource(tx, input.sourceType, input.sourceId);
  // When this is a split bill (skipDuplicateCheck), siblings already exist — don't block.
  if (!input._skipDuplicateCheck) {
    const existing = await siblingLiveBill(tx, input.sourceType, source);
    if (existing) throw new EwayError(`${existing.billNo} already covers this consignment (${existing.status}). Cancel it before making another`, 409);
  }

  const options = await dispatchGstinOptions(tx);
  const gstin = normalizeGstin(input.dispatchGstin);
  const option = options.find((o) => o.gstin === gstin);
  if (!option) throw new EwayError('Dispatch GSTIN is not one of the company GSTINs');

  const config = await getConfig(tx);
  const warehouseId = input.warehouseId || source.warehouseId || source.deliveryNote?.warehouseId || source.salesOrder?.sourceWarehouseId || null;
  const { from, warnings: fromWarnings } = await dispatchFrom(tx, option, warehouseId, input);
  const { lines, warnings: lineWarnings, hasServices, goodsTotal, totalQuantity } = sourceLines(input.sourceType, source);
  if (!lines.length) {
    if (!input.dryRun) throw new EwayError('This document has no goods to move (service lines are not shipped), so an e-way bill cannot be made. Use an invoice or delivery note that has product lines');
    lineWarnings.push('This document has no goods to move (service lines are not shipped), so an e-way bill cannot be made. Use an invoice or delivery note that has product lines');
  }

  const customer = source.customer;
  const shippingSnapshot = source.shippingAddressSnapshot || source.salesOrder?.shippingAddressSnapshot;
  const customerAddress = addressParts(null, customer);
  const shipTo = addressParts(shippingSnapshot, customer);
  const draftInput: EwayBuildInput = {
    sourceType: input.sourceType,
    doc: {
      docNo: input.sourceType === 'SALES_INVOICE' ? source.invoiceNo : source.deliveryNo,
      docDate: input.sourceType === 'SALES_INVOICE' ? source.date : (source.postingDate || source.date),
      // Without service lines the invoice total is the goods total, so rounding and invoice-level discounts carry over.
      grandTotal: input.sourceType === 'SALES_INVOICE' && !hasServices ? num(source.grandTotal) : null,
    },
    dispatch: { gstin, legalName: option.legalName },
    from,
    customer: { name: customer.name, gstin: customer.gstin || (isValidGstin(customer.taxId) ? customer.taxId : null), stateCode: customer.stateCode || customerAddress.stateCode, country: customer.country },
    shipTo: { ...shipTo, stateCode: shipTo.stateCode || customer.stateCode },
    lines,
    transport: transportInput(config, input),
    overrides: { subSupplyType: input.subSupplyType, transactionType: input.transactionType, actualToStateCode: input.actualToStateCode },
  };
  if (input.toAddr1 !== undefined) draftInput.shipTo.addr1 = input.toAddr1;
  if (input.toPlace !== undefined) draftInput.shipTo.place = input.toPlace;
  if (input.toPincode !== undefined) draftInput.shipTo.pincode = input.toPincode;
  const draft = buildEwayDraft(draftInput);
  // Preview: what the bill would hold, so the create form can show and adjust it. Nothing is saved.
  if (input.dryRun) return { preview: true, bill: draft.bill, items: draft.items, errors: draft.errors, warnings: [...fromWarnings, ...lineWarnings, ...draft.warnings], goodsTotal, totalQuantity };

  const billNo = await newBillNo(tx);
  const bill = await tx.ewayBill.create({
    data: {
      ...draft.bill,
      billNo, status: 'DRAFT', source: 'MANUAL', createdById: req.user?.id,
      salesInvoiceId: input.sourceType === 'SALES_INVOICE' ? source.id : undefined,
      deliveryNoteId: input.sourceType === 'DELIVERY_NOTE' ? source.id : undefined,
      splitGroupId: input._splitGroupId || null,
      splitQuantity: input._splitQuantity != null ? input._splitQuantity : null,
      items: { create: draft.items },
      events: { create: { type: 'CREATED', userId: req.user?.id, data: { sourceType: input.sourceType, sourceId: input.sourceId } } },
    },
    include: { items: true },
  });
  await audit(tx, req, { entityType: 'EWAY_BILL', entityId: bill.id, action: 'CREATE', statusAfter: 'DRAFT', message: `Created ${billNo} for ${draft.bill.docNo}${input._splitGroupId ? ' (split shipment)' : ''}` });
  return { bill, errors: draft.errors, warnings: [...fromWarnings, ...lineWarnings, ...draft.warnings], goodsTotal, totalQuantity };
}

// Creates multiple e-way bill drafts in one transaction — one per vehicle.
// All bills share a splitGroupId and each carries a portion of the total quantity.
export async function createSplitBills(
  tx: any,
  req: any,
  input: { sourceType: SourceType; sourceId: string; dispatchGstin: string; vehicles: Array<{ vehicleNo: string; vehicleType?: string; quantity: number }> } & Record<string, any>
) {
  if (!Array.isArray(input.vehicles) || input.vehicles.length < 2) throw new EwayError('Provide at least 2 vehicles for a split shipment');
  for (const vehicle of input.vehicles) {
    if (!vehicle.vehicleNo) throw new EwayError('Each vehicle must have a vehicle number');
    if (!(Number(vehicle.quantity) > 0)) throw new EwayError(`Vehicle ${vehicle.vehicleNo}: quantity must be greater than zero`);
  }

  // Block if a live non-split bill already exists.
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `eway-create:${input.sourceType}:${input.sourceId}`);
  const source = await loadSource(tx, input.sourceType, input.sourceId);
  const existing = await siblingLiveBill(tx, input.sourceType, source);
  if (existing) throw new EwayError(`${existing.billNo} already covers this consignment (${existing.status}). Cancel it before splitting`, 409);

  const { totalQuantity, lines } = sourceLines(input.sourceType, source);
  if (!lines.length || totalQuantity <= 0) {
    throw new EwayError('This document has no goods lines to split across vehicles', 400);
  }

  const totalAssignedQty = round2(input.vehicles.reduce((sum, v) => sum + num(v.quantity), 0));
  if (Math.abs(totalAssignedQty - totalQuantity) > 0.001) {
    throw new EwayError(
      `Total assigned quantity (${totalAssignedQty}) does not match the invoice predefined goods quantity (${totalQuantity}). All ${totalQuantity} units must be strictly accounted for across vehicles.`,
      400
    );
  }

  const splitGroupId = `SPLIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const bills: any[] = [];
  const allWarnings: string[] = [];

  for (const vehicle of input.vehicles) {
    const result = await createBill(tx, req, {
      ...input,
      vehicleNo: vehicle.vehicleNo,
      vehicleType: vehicle.vehicleType || 'R',
      _skipDuplicateCheck: true,
      _splitGroupId: splitGroupId,
      _splitQuantity: Number(vehicle.quantity),
    });
    bills.push(result.bill);
    allWarnings.push(...result.warnings);
  }

  return { bills, splitGroupId, warnings: [...new Set(allWarnings)] };
}

const EDITABLE = ['fromAddr1', 'fromAddr2', 'fromPlace', 'fromPincode', 'fromStateCode', 'actualFromStateCode', 'toName', 'toAddr1', 'toAddr2', 'toPlace', 'toPincode', 'toStateCode', 'actualToStateCode', 'transactionType', 'subSupplyType', 'transportMode', 'distanceKm', 'transporterId', 'transporterName', 'transportDocNo', 'vehicleNo', 'vehicleType'];

export async function getBill(tx: any, id: string) {
  const bill = await tx.ewayBill.findUnique({
    where: { id },
    include: { items: true, events: { orderBy: { createdAt: 'desc' } }, salesInvoice: { select: { id: true, invoiceNo: true, status: true } }, deliveryNote: { select: { id: true, deliveryNo: true, status: true } } },
  });
  if (!bill) throw new EwayError('E-way bill not found', 404);
  let splitSiblings: any[] = [];
  if (bill.splitGroupId) {
    splitSiblings = await tx.ewayBill.findMany({
      where: { splitGroupId: bill.splitGroupId, id: { not: id } },
      select: { id: true, billNo: true, ewbNo: true, vehicleNo: true, vehicleType: true, splitQuantity: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
  }
  return { ...bill, splitSiblings };
}

export function validationFor(bill: any) {
  return validateEwayBill(bill, bill.items.map((item: any) => ({ ...item, quantity: num(item.quantity), taxableAmount: num(item.taxableAmount), cgstRate: num(item.cgstRate), sgstRate: num(item.sgstRate), igstRate: num(item.igstRate), cessRate: num(item.cessRate) })));
}

export async function updateDraft(tx: any, req: any, id: string, input: any) {
  const bill = await getBill(tx, id);
  if (!['DRAFT', 'EXPORTED'].includes(bill.status)) throw new EwayError('Only a draft or exported bill can be edited');
  const data: any = {};
  for (const key of EDITABLE) if (input[key] !== undefined) data[key] = input[key] === '' ? null : input[key];
  if (input.dispatchGstin !== undefined) {
    const gstin = normalizeGstin(input.dispatchGstin);
    if (!(await dispatchGstinOptions(tx)).some((o) => o.gstin === gstin)) throw new EwayError('Dispatch GSTIN is not one of the company GSTINs');
    data.dispatchGstin = gstin; data.fromGstin = gstin;
  }
  if (input.toGstin !== undefined) {
    const toGstin = normalizeGstin(input.toGstin) || 'URP';
    if (toGstin !== 'URP' && !isValidGstin(toGstin)) throw new EwayError('Recipient GSTIN is not valid (use URP for an unregistered recipient)');
    data.toGstin = toGstin;
    if (input.toStateCode === undefined && toGstin !== 'URP') data.toStateCode = stateCodeOfGstin(toGstin);
  }
  if (data.vehicleNo !== undefined) data.vehicleNo = normalizeVehicleNo(data.vehicleNo) || null;
  if (data.transporterId !== undefined) data.transporterId = normalizeGstin(data.transporterId) || null;
  if (data.distanceKm !== undefined) data.distanceKm = Math.max(0, Math.round(Number(data.distanceKm) || 0));
  if (input.transportDocDate !== undefined) data.transportDocDate = input.transportDocDate ? new Date(input.transportDocDate) : null;
  if (data.transportMode !== undefined) data.transportMode = String(data.transportMode).toUpperCase();
  // Editing an exported bill means the file already uploaded is stale: it must be exported again.
  if (bill.status === 'EXPORTED') { data.status = 'DRAFT'; }
  // A new from/to state (or recipient GSTIN) can turn the supply from intra- to inter-state, so the GST split is redone.
  if (data.fromStateCode !== undefined || data.toStateCode !== undefined || data.toGstin !== undefined) {
    const fromState = data.fromStateCode !== undefined ? data.fromStateCode : bill.fromStateCode;
    const toState = data.toStateCode !== undefined ? data.toStateCode : bill.toStateCode;
    const interState = !!fromState && !!toState && fromState !== toState;
    const totals = { cgst: 0, sgst: 0, igst: 0, cess: 0, taxable: 0 };
    for (const item of bill.items) {
      const gst = num(item.cgstRate) + num(item.sgstRate) + num(item.igstRate);
      const rates = interState ? { cgst: 0, sgst: 0, igst: gst } : { cgst: gst / 2, sgst: gst / 2, igst: 0 };
      const taxable = num(item.taxableAmount);
      totals.taxable += taxable;
      totals.cgst += round2(taxable * rates.cgst / 100);
      totals.sgst += round2(taxable * rates.sgst / 100);
      totals.igst += round2(taxable * rates.igst / 100);
      totals.cess += round2(taxable * num(item.cessRate) / 100);
      await tx.ewayBillItem.update({ where: { id: item.id }, data: { cgstRate: rates.cgst, sgstRate: rates.sgst, igstRate: rates.igst } });
    }
    data.taxableValue = round2(totals.taxable);
    data.cgstValue = round2(totals.cgst); data.sgstValue = round2(totals.sgst); data.igstValue = round2(totals.igst); data.cessValue = round2(totals.cess);
    data.totalValue = round2(totals.taxable + totals.cgst + totals.sgst + totals.igst + totals.cess + num(bill.otherValue));
  }
  await tx.ewayBill.update({ where: { id }, data });

  for (const edit of input.items || []) {
    const row = bill.items.find((item: any) => item.id === edit.id);
    if (!row) continue;
    const itemData: any = {};
    if (edit.hsnCode !== undefined) itemData.hsnCode = String(edit.hsnCode).replace(/\s+/g, '');
    if (edit.qtyUnit !== undefined) itemData.qtyUnit = uqcFor(edit.qtyUnit) || String(edit.qtyUnit).toUpperCase();
    if (Object.keys(itemData).length) await tx.ewayBillItem.update({ where: { id: row.id }, data: itemData });
  }
  await tx.ewayBillEvent.create({ data: { ewayBillId: id, type: 'EDITED', userId: req.user?.id, data: { fields: [...Object.keys(data), ...(input.items?.length ? ['items'] : [])] } } });
  await audit(tx, req, { entityType: 'EWAY_BILL', entityId: id, action: 'UPDATE', statusBefore: bill.status, statusAfter: data.status || bill.status, message: `Edited ${bill.billNo}` });
  return getBill(tx, id);
}

export async function deleteDraft(tx: any, req: any, id: string) {
  const bill = await getBill(tx, id);
  if (!['DRAFT', 'EXPORTED'].includes(bill.status)) throw new EwayError('Only a draft or exported bill can be deleted; cancel a generated bill instead');
  await audit(tx, req, { entityType: 'EWAY_BILL', entityId: id, action: 'DELETE', statusBefore: bill.status, message: `Deleted ${bill.billNo}` });
  await tx.ewayBill.delete({ where: { id } });
}

// Builds the NIC bulk-upload file. Every bill must pass validation first: a file the portal would reject
// wastes the user's trip to the portal.
export async function exportBills(tx: any, req: any, ids: string[]) {
  if (!ids.length) throw new EwayError('Select at least one e-way bill to export');
  const bills = await tx.ewayBill.findMany({ where: { id: { in: ids } }, include: { items: true } });
  if (bills.length !== new Set(ids).size) throw new EwayError('One or more e-way bills were not found', 404);
  const problems: string[] = [];
  for (const bill of bills) {
    if (!['DRAFT', 'EXPORTED'].includes(bill.status)) { problems.push(`${bill.billNo}: already ${bill.status.toLowerCase()}, nothing to export`); continue; }
    for (const message of validationFor(bill)) problems.push(`${bill.billNo}: ${message}`);
  }
  if (problems.length) throw new EwayError('Fix these problems before exporting', 400, problems);
  const entries = bills.map((bill: any) => toNicBill(bill, bill.items));
  for (const bill of bills) {
    await tx.ewayBill.update({ where: { id: bill.id }, data: { status: 'EXPORTED', exportedAt: new Date(), payload: toNicBill(bill, bill.items) } });
    await tx.ewayBillEvent.create({ data: { ewayBillId: bill.id, type: 'EXPORTED', userId: req.user?.id } });
    await audit(tx, req, { entityType: 'EWAY_BILL', entityId: bill.id, action: 'EXPORT', statusBefore: bill.status, statusAfter: 'EXPORTED', message: `Exported ${bill.billNo}` });
  }
  return buildNicBulkFile(entries);
}

// The sales order kept a free-text e-way bill number before this feature. It lists every generated bill of the
// order (an order can leave in several vehicles), and clears when none is left.
async function syncOrderEwayNumber(tx: any, bill: any) {
  const salesOrderId = bill.salesInvoiceId
    ? (await tx.salesInvoice.findUnique({ where: { id: bill.salesInvoiceId }, select: { salesOrderId: true } }))?.salesOrderId
    : bill.deliveryNoteId ? (await tx.deliveryNote.findUnique({ where: { id: bill.deliveryNoteId }, select: { salesOrderId: true } }))?.salesOrderId : null;
  if (!salesOrderId) return;
  const live = await tx.ewayBill.findMany({
    where: { ewbNo: { not: null }, status: { in: ['GENERATED', 'EXPIRED'] }, OR: [{ salesInvoice: { salesOrderId } }, { deliveryNote: { salesOrderId } }] },
    select: { ewbNo: true }, orderBy: { ewbDate: 'asc' },
  });
  const numbers = [...new Set<string>(live.map((row: any) => row.ewbNo))];
  await tx.salesOrder.updateMany({ where: { id: salesOrderId }, data: { eWayBillNo: numbers.length ? numbers.join(', ') : null } });
}

export async function recordNumber(tx: any, req: any, id: string, input: { ewbNo?: string; ewbDate?: string; validUntil?: string }) {
  const bill = await getBill(tx, id);
  if (!['DRAFT', 'EXPORTED'].includes(bill.status)) throw new EwayError(`This bill is already ${bill.status.toLowerCase()}`);
  const ewbNo = String(input.ewbNo || '').replace(/\s+/g, '');
  if (!EWB_NUMBER_PATTERN.test(ewbNo)) throw new EwayError('The e-way bill number must be 12 digits');
  const duplicate = await tx.ewayBill.findFirst({ where: { ewbNo, id: { not: id } }, select: { billNo: true } });
  if (duplicate) throw new EwayError(`E-way bill number ${ewbNo} is already recorded on ${duplicate.billNo}`, 409);
  const ewbDate = input.ewbDate ? new Date(input.ewbDate) : new Date();
  if (Number.isNaN(ewbDate.getTime())) throw new EwayError('E-way bill date is not valid');
  if (ewbDate.getTime() > Date.now() + 5 * 60 * 1000) throw new EwayError('E-way bill date cannot be in the future');
  // Distance 0 means the portal worked the distance out, so the validity cannot be estimated here: an estimate
  // from 0 km would be one day and the bill would be marked expired while it is still valid on the portal.
  if (!input.validUntil && !(bill.distanceKm > 0)) throw new EwayError('Enter "Valid until" from the portal. This bill has distance 0 (the portal calculated it), so the validity cannot be estimated');
  const validUntil = input.validUntil ? new Date(input.validUntil) : suggestedValidUntil(ewbDate, bill.distanceKm, bill.vehicleType === 'O');
  if (Number.isNaN(validUntil.getTime()) || validUntil.getTime() <= ewbDate.getTime()) throw new EwayError('Valid-until must be after the e-way bill date');

  await tx.ewayBill.update({ where: { id }, data: { status: 'GENERATED', source: 'MANUAL', ewbNo, ewbDate, validUntil, errorMessage: null } });
  await tx.ewayBillEvent.create({ data: { ewayBillId: id, type: 'NUMBER_RECORDED', userId: req.user?.id, data: { ewbNo, ewbDate, validUntil, validityEnteredByUser: Boolean(input.validUntil) } } });
  await syncOrderEwayNumber(tx, bill);
  await audit(tx, req, { entityType: 'EWAY_BILL', entityId: id, action: 'RECORD_NUMBER', statusBefore: bill.status, statusAfter: 'GENERATED', message: `Recorded e-way bill ${ewbNo} on ${bill.billNo}` });
  return getBill(tx, id);
}

export async function recordCancel(tx: any, req: any, id: string, input: { reason?: string }) {
  const bill = await getBill(tx, id);
  if (!['GENERATED', 'EXPIRED'].includes(bill.status)) throw new EwayError('Only a generated e-way bill can be cancelled');
  const reason = String(input.reason || '').trim();
  if (!reason) throw new EwayError('A cancellation reason is required');
  const withinWindow = bill.ewbDate ? canCancelOnPortal(bill.ewbDate) : false;
  await tx.ewayBill.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
  await syncOrderEwayNumber(tx, bill);
  await tx.ewayBillEvent.create({ data: { ewayBillId: id, type: 'CANCELLED', userId: req.user?.id, data: { reason, withinPortalWindow: withinWindow } } });
  await audit(tx, req, { entityType: 'EWAY_BILL', entityId: id, action: 'CANCEL', statusBefore: bill.status, statusAfter: 'CANCELLED', message: `Cancelled ${bill.billNo}: ${reason}` });
  return { bill: await getBill(tx, id), warnings: withinWindow ? [] : ['The 24 hour cancellation window had passed; confirm the cancellation was accepted on the portal'] };
}

async function recordMultiVehicle(tx: any, req: any, bill: any, input: any) {
  const targetQty = bill.splitQuantity != null && Number(bill.splitQuantity) > 0
    ? Number(bill.splitQuantity)
    : round2((bill.items || []).reduce((sum: number, it: any) => sum + num(it.quantity), 0));

  if (!String(input.fromPlace || '').trim()) throw new EwayError('The transshipment place is required');
  if (!Array.isArray(input.vehicles) || input.vehicles.length < 2) throw new EwayError('Provide at least 2 vehicles for transshipment split');

  for (const v of input.vehicles) {
    const vno = normalizeVehicleNo(v.vehicleNo);
    if (!VEHICLE_PATTERN.test(vno)) throw new EwayError(`Vehicle number ${v.vehicleNo || ''} is not valid (example MH12AB1234)`);
    if (!(Number(v.quantity) > 0)) throw new EwayError(`Vehicle ${vno}: quantity must be greater than zero`);
  }

  const totalAssigned = round2(input.vehicles.reduce((s: number, v: any) => s + num(v.quantity), 0));
  if (targetQty > 0 && Math.abs(totalAssigned - targetQty) > 0.001) {
    throw new EwayError(
      `Total assigned quantity (${totalAssigned}) does not match the consignment quantity (${targetQty}). All ${targetQty} units must be strictly accounted for across vehicles.`,
      400
    );
  }

  const splitGroupId = bill.splitGroupId || `SPLIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const firstVehicle = input.vehicles[0];
  const firstVehicleNo = normalizeVehicleNo(firstVehicle.vehicleNo);

  // Update original bill with vehicle 0 and its portion of split quantity
  await tx.ewayBill.update({
    where: { id: bill.id },
    data: {
      vehicleNo: firstVehicleNo,
      vehicleType: firstVehicle.vehicleType === 'O' ? 'O' : bill.vehicleType,
      splitGroupId,
      splitQuantity: Number(firstVehicle.quantity),
      ...(input.transportDocNo !== undefined ? { transportDocNo: input.transportDocNo || null } : {}),
      ...(input.transportDocDate ? { transportDocDate: new Date(input.transportDocDate) } : {}),
    },
  });

  await tx.ewayBillEvent.create({
    data: {
      ewayBillId: bill.id,
      type: 'VEHICLE_UPDATED',
      userId: req.user?.id,
      data: {
        previousVehicleNo: bill.vehicleNo,
        vehicleNo: firstVehicleNo,
        fromPlace: input.fromPlace,
        fromState: input.fromState,
        reason: input.reason || 'Transshipment split into multiple vehicles',
        remarks: input.remarks,
        splitGroupId,
        splitQuantity: Number(firstVehicle.quantity),
        multiVehicle: true,
      },
    },
  });

  // Create sibling bills for vehicles 1..n sharing the parent ewbNo and group
  for (let i = 1; i < input.vehicles.length; i++) {
    const v = input.vehicles[i];
    const vNo = normalizeVehicleNo(v.vehicleNo);
    const newNo = await newBillNo(tx);
    await tx.ewayBill.create({
      data: {
        companyId: bill.companyId || undefined,
        billNo: newNo,
        status: bill.status,
        source: bill.source || 'MANUAL',
        ewbNo: bill.ewbNo,
        ewbDate: bill.ewbDate,
        validUntil: bill.validUntil,
        irn: bill.irn,
        sourceType: bill.sourceType,
        salesInvoiceId: bill.salesInvoiceId || undefined,
        deliveryNoteId: bill.deliveryNoteId || undefined,
        stockTransferOrderId: bill.stockTransferOrderId || undefined,
        purchaseReturnId: bill.purchaseReturnId || undefined,
        supplyType: bill.supplyType,
        subSupplyType: bill.subSupplyType,
        docType: bill.docType,
        docNo: bill.docNo,
        docDate: bill.docDate,
        transactionType: bill.transactionType,
        dispatchGstin: bill.dispatchGstin,
        fromGstin: bill.fromGstin,
        fromName: bill.fromName,
        fromAddr1: bill.fromAddr1,
        fromAddr2: bill.fromAddr2,
        fromPlace: bill.fromPlace,
        fromPincode: bill.fromPincode,
        fromStateCode: bill.fromStateCode,
        actualFromStateCode: bill.actualFromStateCode,
        toGstin: bill.toGstin,
        toName: bill.toName,
        toAddr1: bill.toAddr1,
        toAddr2: bill.toAddr2,
        toPlace: bill.toPlace,
        toPincode: bill.toPincode,
        toStateCode: bill.toStateCode,
        actualToStateCode: bill.actualToStateCode,
        taxableValue: bill.taxableValue,
        cgstValue: bill.cgstValue,
        sgstValue: bill.sgstValue,
        igstValue: bill.igstValue,
        cessValue: bill.cessValue,
        otherValue: bill.otherValue,
        totalValue: bill.totalValue,
        transportMode: bill.transportMode,
        distanceKm: bill.distanceKm,
        transporterId: bill.transporterId,
        transporterName: bill.transporterName,
        transportDocNo: input.transportDocNo ?? bill.transportDocNo,
        transportDocDate: input.transportDocDate ? new Date(input.transportDocDate) : bill.transportDocDate,
        vehicleNo: vNo,
        vehicleType: v.vehicleType === 'O' ? 'O' : bill.vehicleType,
        createdById: req.user?.id,
        splitGroupId,
        splitQuantity: Number(v.quantity),
        items: {
          create: (bill.items || []).map((it: any) => ({
            productId: it.productId,
            productName: it.productName,
            description: it.description,
            hsnCode: it.hsnCode,
            quantity: it.quantity,
            qtyUnit: it.qtyUnit,
            taxableAmount: it.taxableAmount,
            cgstRate: it.cgstRate,
            sgstRate: it.sgstRate,
            igstRate: it.igstRate,
            cessRate: it.cessRate,
          })),
        },
        events: {
          create: {
            type: 'VEHICLE_UPDATED',
            userId: req.user?.id,
            data: {
              previousVehicleNo: bill.vehicleNo,
              vehicleNo: vNo,
              fromPlace: input.fromPlace,
              fromState: input.fromState,
              reason: input.reason || 'Transshipment split into multiple vehicles',
              remarks: input.remarks,
              splitGroupId,
              splitQuantity: Number(v.quantity),
              multiVehicle: true,
            },
          },
        },
      },
    });
  }

  await audit(tx, req, {
    entityType: 'EWAY_BILL',
    entityId: bill.id,
    action: 'UPDATE_VEHICLE',
    statusBefore: bill.status,
    statusAfter: bill.status,
    message: `Split into ${input.vehicles.length} vehicles at ${[input.fromPlace, input.fromState].filter(Boolean).join(', ')} for ${bill.billNo} (Group: ${splitGroupId})`,
  });

  return getBill(tx, bill.id);
}

export async function recordVehicle(tx: any, req: any, id: string, input: any) {
  const bill = await getBill(tx, id);
  if (bill.status !== 'GENERATED') throw new EwayError('Vehicle can only be changed on a generated e-way bill');

  if (Array.isArray(input.vehicles) && input.vehicles.length >= 2) {
    return recordMultiVehicle(tx, req, bill, input);
  }

  const vehicleNo = normalizeVehicleNo(input.vehicleNo);
  if (!VEHICLE_PATTERN.test(vehicleNo)) throw new EwayError('Vehicle number format is not valid (example MH12AB1234)');
  if (!String(input.reason || '').trim()) throw new EwayError('A reason for the vehicle change is required');
  if (!String(input.fromPlace || '').trim()) throw new EwayError('The place the vehicle is changed at is required');
  const data: any = { vehicleNo, vehicleType: input.vehicleType === 'O' ? 'O' : bill.vehicleType };
  if (input.transportDocNo !== undefined) data.transportDocNo = input.transportDocNo || null;
  if (input.transportDocDate) data.transportDocDate = new Date(input.transportDocDate);
  await tx.ewayBill.update({ where: { id }, data });
  await tx.ewayBillEvent.create({ data: { ewayBillId: id, type: 'VEHICLE_UPDATED', userId: req.user?.id, data: { previousVehicleNo: bill.vehicleNo, vehicleNo, fromPlace: input.fromPlace, fromState: input.fromState, reason: input.reason, remarks: input.remarks } } });
  await audit(tx, req, { entityType: 'EWAY_BILL', entityId: id, action: 'UPDATE_VEHICLE', statusBefore: bill.status, statusAfter: bill.status, message: `Vehicle changed from ${bill.vehicleNo || 'none'} to ${vehicleNo} at ${[input.fromPlace, input.fromState].filter(Boolean).join(', ')} on ${bill.billNo} (${String(input.reason).trim()})` });
  return getBill(tx, id);
}

export async function recordExtension(tx: any, req: any, id: string, input: any) {
  const bill = await getBill(tx, id);
  if (!['GENERATED', 'EXPIRED'].includes(bill.status)) throw new EwayError('Validity can only be extended on a generated e-way bill');
  const validUntil = new Date(input.validUntil);
  if (Number.isNaN(validUntil.getTime())) throw new EwayError('New valid-until date is required');
  if (bill.validUntil && validUntil.getTime() <= bill.validUntil.getTime()) throw new EwayError('New valid-until must be later than the current one');
  if (!String(input.reason || '').trim()) throw new EwayError('A reason for the extension is required');
  await tx.ewayBill.update({ where: { id }, data: { validUntil, status: validUntil.getTime() > Date.now() ? 'GENERATED' : 'EXPIRED' } });
  await tx.ewayBillEvent.create({ data: { ewayBillId: id, type: 'EXTENDED', userId: req.user?.id, data: { previousValidUntil: bill.validUntil, validUntil, remainingDistanceKm: input.remainingDistanceKm, fromPlace: input.fromPlace, reason: input.reason } } });
  await audit(tx, req, { entityType: 'EWAY_BILL', entityId: id, action: 'EXTEND', statusBefore: bill.status, statusAfter: 'GENERATED', message: `Extended validity of ${bill.billNo}` });
  return getBill(tx, id);
}

// Cancelling an invoice or delivery note must not leave a live e-way bill pointing at it. Drafts are discarded;
// an exported, generated or expired bill may exist on the portal, so it must be cancelled there and recorded first.
export async function assertNoLiveEwayBill(tx: any, where: { salesInvoiceId?: string; deliveryNoteId?: string }) {
  const bills = await tx.ewayBill.findMany({ where: { ...where, status: { in: ['DRAFT', 'EXPORTED', 'GENERATED', 'EXPIRED'] } } });
  const blocking = bills.filter((bill: any) => bill.status !== 'DRAFT');
  if (blocking.length) throw new Error(`Cancel e-way bill ${blocking.map((b: any) => b.billNo).join(', ')} first`);
  if (bills.length) await tx.ewayBill.deleteMany({ where: { id: { in: bills.map((b: any) => b.id) } } });
}

export async function markExpiredBills() {
  // Imported lazily: the sweep runs outside a request, across every company.
  const { default: prisma } = await import('../../lib/prisma');
  const result = await prisma.ewayBill.updateMany({ where: { status: 'GENERATED', validUntil: { lt: new Date() } }, data: { status: 'EXPIRED' } });
  return { expired: result.count };
}

export async function expiringSoon(tx: any, hours = 24) {
  const now = new Date();
  return tx.ewayBill.findMany({
    where: { status: 'GENERATED', validUntil: { gte: now, lte: new Date(now.getTime() + hours * 3600 * 1000) } },
    orderBy: { validUntil: 'asc' }, take: 200,
  });
}

// Shipped goods with no e-way bill: submitted documents above the threshold with no live bill on them.
// With soft warnings this report is the control, so it is cheap to run and lists the oldest first.
export async function pendingReport(tx: any, days = 30) {
  const config = await getConfig(tx);
  const threshold = num(config.valueThreshold);
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
  const rows: any[] = [];

  const invoices = await tx.salesInvoice.findMany({
    where: { status: 'SUBMITTED', date: { gte: since } },
    include: { customer: { select: { name: true } }, items: { include: { product: { select: { type: true } } } } },
    orderBy: { date: 'asc' }, take: 500,
  });
  const noteIdsOnInvoices = new Set(invoices.map((invoice: any) => invoice.deliveryNoteId).filter(Boolean));
  const liveBills = await tx.ewayBill.findMany({ where: { status: { in: LIVE_STATUSES } }, select: { salesInvoiceId: true, deliveryNoteId: true } });
  const billedInvoices = new Set(liveBills.map((b: any) => b.salesInvoiceId).filter(Boolean));
  const billedNotes = new Set(liveBills.map((b: any) => b.deliveryNoteId).filter(Boolean));

  for (const invoice of invoices) {
    const goods = invoice.items.filter((item: any) => item.product?.type === 'PRODUCT');
    const value = round2(goods.reduce((total: number, item: any) => total + num(item.total), 0));
    if (!isEwayRequired({ totalValue: value, threshold, hasGoods: goods.length > 0 }).required) continue;
    if (billedInvoices.has(invoice.id) || (invoice.deliveryNoteId && billedNotes.has(invoice.deliveryNoteId))) continue;
    rows.push({ sourceType: 'SALES_INVOICE', sourceId: invoice.id, docNo: invoice.invoiceNo, date: invoice.date, customer: invoice.customer?.name, value, ageDays: Math.floor((Date.now() - new Date(invoice.date).getTime()) / 86400000) });
  }

  // Delivery notes that have not been invoiced yet move goods with no invoice to hang a bill on.
  const invoicedNoteIds = new Set((await tx.salesInvoice.findMany({ where: { deliveryNoteId: { not: null }, status: { not: 'CANCELLED' } }, select: { deliveryNoteId: true } })).map((i: any) => i.deliveryNoteId));
  const notes = await tx.deliveryNote.findMany({
    where: { status: 'SUBMITTED', date: { gte: since } },
    include: { customer: { select: { name: true } }, items: { include: { product: { select: { type: true } } } }, salesOrder: { include: { items: true } } },
    orderBy: { date: 'asc' }, take: 300,
  });
  for (const note of notes) {
    if (invoicedNoteIds.has(note.id) || noteIdsOnInvoices.has(note.id) || billedNotes.has(note.id)) continue;
    const prices = new Map<string, any>((note.salesOrder?.items || []).map((item: any) => [item.productId, item]));
    let value = 0; let goods = 0;
    for (const item of note.items) {
      if (item.product?.type !== 'PRODUCT') continue;
      goods += 1;
      const price = prices.get(item.productId);
      if (!price) continue;
      const taxable = num(item.quantity) * num(price.unitPrice) * (1 - num(price.discount) / 100);
      value += taxable * (1 + num(price.taxRate) / 100);
    }
    value = round2(value);
    if (!isEwayRequired({ totalValue: value, threshold, hasGoods: goods > 0 }).required) continue;
    rows.push({ sourceType: 'DELIVERY_NOTE', sourceId: note.id, docNo: note.deliveryNo, date: note.date, customer: note.customer?.name, value, ageDays: Math.floor((Date.now() - new Date(note.date).getTime()) / 86400000) });
  }
  return { threshold, items: rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) };
}
