import { describe, expect, it } from 'vitest';
import { buildEwayDraft, buildNicBulkFile, formatNicDate, splitLineTax, toNicBill, type EwayBuildInput } from './ewayPayload.service';
import { canCancelOnPortal, isEwayRequired, isValidGstin, stateCodeFromName, suggestedValidUntil, suggestedValidityDays, uqcFor } from './ewayRules.service';

const MH_GSTIN = '27AAPFU0939F1ZV';
const KA_GSTIN = '29AABCT1332L1ZX';

function input(overrides: Partial<EwayBuildInput> = {}): EwayBuildInput {
  return {
    sourceType: 'SALES_INVOICE',
    doc: { docNo: 'INV-0001', docDate: new Date('2026-10-15T08:00:00Z'), grandTotal: 118000 },
    dispatch: { gstin: MH_GSTIN, legalName: 'Orus Industries Pvt Ltd' },
    from: { addr1: 'Plot 4, MIDC', place: 'Pune', pincode: '411019', stateCode: '27' },
    customer: { name: 'Acme Traders', gstin: MH_GSTIN, country: 'India' },
    shipTo: { addr1: '12 Market Road', place: 'Mumbai', pincode: '400001', stateCode: '27' },
    lines: [{ productName: 'Steel Rod', hsnCode: '7214', unitSymbol: 'kg', quantity: 100, taxableAmount: 100000, taxRate: 18, taxes: [{ label: 'CGST 9%', rate: 9 }, { label: 'SGST 9%', rate: 9 }] }],
    transport: { mode: 'ROAD', distanceKm: 150, vehicleNo: 'mh 12 ab 1234' },
    ...overrides,
  };
}

describe('e-way bill rules', () => {
  it('validates GSTINs and state names', () => {
    expect(isValidGstin(MH_GSTIN)).toBe(true);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
    expect(stateCodeFromName('Maharashtra')).toBe('27');
    expect(stateCodeFromName('orissa')).toBe('21');
    expect(stateCodeFromName('Nowhere')).toBeNull();
  });

  it('applies the value threshold and ignores service-only documents', () => {
    expect(isEwayRequired({ totalValue: 50000, hasGoods: true }).required).toBe(false);
    expect(isEwayRequired({ totalValue: 50001, hasGoods: true }).required).toBe(true);
    expect(isEwayRequired({ totalValue: 90000, hasGoods: false }).required).toBe(false);
    expect(isEwayRequired({ totalValue: 40000, threshold: 10000, hasGoods: true }).required).toBe(true);
  });

  it('suggests one day per 200 km and 24 hour cancel window', () => {
    expect(suggestedValidityDays(0)).toBe(1);
    expect(suggestedValidityDays(200)).toBe(1);
    expect(suggestedValidityDays(201)).toBe(2);
    expect(suggestedValidityDays(250, true)).toBe(3);
    const generated = new Date('2026-10-15T10:00:00Z');
    expect(canCancelOnPortal(generated, new Date('2026-10-16T09:59:00Z'))).toBe(true);
    expect(canCancelOnPortal(generated, new Date('2026-10-16T10:01:00Z'))).toBe(false);
  });

  it('ends validity at 23:59 Indian time on the last day', () => {
    // 15 Oct 2026 10:00 UTC is 15:30 IST; 150 km is one day, so validity ends 16 Oct 23:59 IST = 18:29 UTC.
    expect(suggestedValidUntil(new Date('2026-10-15T10:00:00Z'), 150).toISOString()).toBe('2026-10-16T18:29:00.000Z');
    expect(suggestedValidUntil(new Date('2026-10-15T10:00:00Z'), 450).toISOString()).toBe('2026-10-18T18:29:00.000Z');
  });

  it('maps unit symbols to UQC', () => {
    expect(uqcFor('Kg')).toBe('KGS');
    expect(uqcFor('nos')).toBe('NOS');
    expect(uqcFor('furlong')).toBeNull();
  });
});

describe('e-way bill payload', () => {
  it('builds an intra-state bill with CGST + SGST and no errors', () => {
    const { bill, items, errors } = buildEwayDraft(input());
    expect(errors).toEqual([]);
    expect(bill.docType).toBe('INV');
    expect(bill.vehicleNo).toBe('MH12AB1234');
    expect(bill.taxableValue).toBe(100000);
    expect(bill.cgstValue).toBe(9000);
    expect(bill.sgstValue).toBe(9000);
    expect(bill.igstValue).toBe(0);
    expect(bill.totalValue).toBe(118000);
    expect(bill.otherValue).toBe(0);
    expect(items[0].qtyUnit).toBe('KGS');
  });

  it('falls back to the plain rate when tax labels are not recognisable', () => {
    expect(splitLineTax({ productName: 'x', quantity: 1, taxableAmount: 100, taxRate: 18, taxes: [{ label: 'Output Tax', rate: 18 }] }, false)).toMatchObject({ cgst: 9, sgst: 9, igst: 0 });
    expect(splitLineTax({ productName: 'x', quantity: 1, taxableAmount: 100, taxRate: 18 }, true)).toMatchObject({ cgst: 0, sgst: 0, igst: 18 });
  });

  it('uses IGST for an inter-state sale and rejects CGST/SGST labels on it', () => {
    const inter = buildEwayDraft(input({ customer: { name: 'Karnataka Co', gstin: KA_GSTIN }, shipTo: { addr1: '5 MG Road', place: 'Bengaluru', pincode: '560001', stateCode: '29' }, lines: [{ productName: 'Steel Rod', hsnCode: '7214', unitSymbol: 'kg', quantity: 100, taxableAmount: 100000, taxRate: 18 }] }));
    expect(inter.interState).toBe(true);
    expect(inter.bill.igstValue).toBe(18000);
    expect(inter.errors).toEqual([]);

    const wrong = buildEwayDraft(input({ customer: { name: 'Karnataka Co', gstin: KA_GSTIN }, shipTo: { addr1: '5 MG Road', place: 'Bengaluru', pincode: '560001', stateCode: '29' } }));
    expect(wrong.errors.join(' ')).toMatch(/CGST\/SGST cannot be used on an inter-state/);
  });

  it('uses URP for an unregistered customer and bill-to/ship-to when the states differ', () => {
    const urp = buildEwayDraft(input({ customer: { name: 'Walk-in', gstin: null, stateCode: '27' } }));
    expect(urp.bill.toGstin).toBe('URP');

    const split = buildEwayDraft(input({ customer: { name: 'Acme', gstin: MH_GSTIN }, shipTo: { addr1: '5 MG Road', place: 'Bengaluru', pincode: '560001', stateCode: '29' } }));
    expect(split.bill.transactionType).toBe(2);
    expect(split.bill.toStateCode).toBe('27');
    expect(split.bill.actualToStateCode).toBe('29');
  });

  it('makes a delivery note bill a challan under "Others" with zero tax', () => {
    const { bill, items, errors, warnings } = buildEwayDraft(input({ sourceType: 'DELIVERY_NOTE' }));
    expect(bill.docType).toBe('CHL');
    expect(bill.subSupplyType).toBe(8);
    expect(items.every((i) => i.cgstRate === 0 && i.sgstRate === 0 && i.igstRate === 0)).toBe(true);
    expect(bill.cgstValue + bill.sgstValue + bill.igstValue).toBe(0);
    expect(bill.totalValue).toBe(bill.taxableValue);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('Delivery challan bill'))).toBe(true);
    expect(toNicBill(bill, items)).toMatchObject({ docType: 'CHL', subSupplyType: 8, subSupplyDesc: 'Delivery challan' });
  });

  it('treats a foreign customer as an export', () => {
    const { bill } = buildEwayDraft(input({ customer: { name: 'Overseas Ltd', country: 'Germany' } }));
    expect(bill.subSupplyType).toBe(3);
    expect(bill.toGstin).toBe('URP');
    expect(bill.toStateCode).toBe('99');
    expect(bill.toPincode).toBe('999999');
  });

  it('captures round-off or discount as other value', () => {
    const { bill } = buildEwayDraft(input({ doc: { docNo: 'INV-2', docDate: new Date(), grandTotal: 117999.5 } }));
    expect(bill.otherValue).toBe(-0.5);
    expect(bill.totalValue).toBe(117999.5);
  });

  it('reports every blocking problem before export', () => {
    const { errors } = buildEwayDraft(input({
      dispatch: { gstin: KA_GSTIN },
      from: { addr1: '', pincode: '12', stateCode: '27' },
      lines: [{ productName: 'Mystery', hsnCode: '12', unitSymbol: 'furlong', quantity: 0, taxableAmount: 10, taxRate: 18 }],
      transport: { mode: 'ROAD', distanceKm: 9999, vehicleNo: '' },
    }));
    const text = errors.join(' | ');
    expect(text).toMatch(/belongs to state 29 but the dispatch warehouse is in state 27/);
    expect(text).toMatch(/Dispatch pincode/);
    expect(text).toMatch(/Dispatch address/);
    expect(text).toMatch(/HSN must be 4, 6 or 8 digits/);
    expect(text).toMatch(/no matching UQC/);
    expect(text).toMatch(/quantity must be above zero/);
    expect(text).toMatch(/Distance must be between/);
    expect(text).toMatch(/vehicle number or the transporter ID/);
  });

  it('requires a transport document for rail, air and ship', () => {
    const { errors } = buildEwayDraft(input({ transport: { mode: 'RAIL', distanceKm: 800 } }));
    expect(errors.join(' ')).toMatch(/Transport document number/);
  });

  it('writes the NIC bulk file with portal date format and numeric codes', () => {
    const { bill, items } = buildEwayDraft(input());
    const file = buildNicBulkFile([toNicBill(bill, items)]);
    const entry = file.billLists[0];
    expect(file.version).toBe('1.0.0621');
    expect(entry.docDate).toBe('15/10/2026');
    expect(entry.userGstin).toBe(MH_GSTIN);
    expect(entry.transMode).toBe(1);
    expect(entry.fromStateCode).toBe(27);
    expect(entry.totalValue).toBe(100000);
    expect(entry.totInvValue).toBe(118000);
    expect(entry.vehicleNo).toBe('MH12AB1234');
    expect(entry.transType).toBe(1);
    expect(entry.OthValue).toBe(0);
    expect(entry.TotNonAdvolVal).toBe(0);
    expect(entry.transDistance).toBe(150);
    expect(entry).not.toHaveProperty('transactionType');
    expect(entry.itemList[0]).toMatchObject({ hsnCode: '7214', qtyUnit: 'KGS', cgstRate: 9, sgstRate: 9, igstRate: 0 });
    expect(formatNicDate(new Date('2026-10-15T20:00:00Z'))).toBe('16/10/2026');
  });

  it('validates multi-vehicle split shipment inputs', async () => {
    const { createSplitBills, EwayError } = await import('./ewayBill.service');
    const mockTx = {
      $executeRawUnsafe: async () => {},
    };

    // Less than 2 vehicles
    await expect(
      createSplitBills(mockTx, { user: { id: 'u1' } }, {
        sourceType: 'SALES_INVOICE',
        sourceId: 'inv-1',
        dispatchGstin: MH_GSTIN,
        vehicles: [{ vehicleNo: 'MH12AB1234', quantity: 50 }],
      })
    ).rejects.toThrow('Provide at least 2 vehicles');

    // Missing vehicle number
    await expect(
      createSplitBills(mockTx, { user: { id: 'u1' } }, {
        sourceType: 'SALES_INVOICE',
        sourceId: 'inv-1',
        dispatchGstin: MH_GSTIN,
        vehicles: [
          { vehicleNo: '', quantity: 50 },
          { vehicleNo: 'MH12CD5678', quantity: 50 },
        ],
      })
    ).rejects.toThrow('Each vehicle must have a vehicle number');

    // Zero or negative quantity
    await expect(
      createSplitBills(mockTx, { user: { id: 'u1' } }, {
        sourceType: 'SALES_INVOICE',
        sourceId: 'inv-1',
        dispatchGstin: MH_GSTIN,
        vehicles: [
          { vehicleNo: 'MH12AB1234', quantity: 0 },
          { vehicleNo: 'MH12CD5678', quantity: 50 },
        ],
      })
    ).rejects.toThrow('quantity must be greater than zero');

    // Mismatched total quantity vs invoice predefined quantity (100 in invoice, 110 assigned)
    const mockInvoice = {
      id: 'inv-1',
      status: 'SUBMITTED',
      invoiceNo: 'INV-2026-001',
      date: new Date('2026-10-15'),
      grandTotal: 118000,
      customer: {
        name: 'Acme Infra Ltd',
        gstin: MH_GSTIN,
        stateCode: 27,
        address: 'Plot 4, MIDC, Pune',
        city: 'Pune',
        zip: '411018',
        country: 'India',
      },
      items: [
        {
          productId: 'prod-1',
          quantity: 100,
          rate: 1000,
          discount: 0,
          netAmount: 100000,
          taxRate: 18,
          taxAmount: 18000,
          total: 118000,
          product: { type: 'PRODUCT', name: 'TMT Steel 12mm', hsnCode: '7214', unit: { symbol: 'KGS' } },
          taxes: [{ label: 'GST', rate: 18 }],
        },
      ],
    };

    const mockTxWithDoc = {
      $executeRawUnsafe: async () => {},
      salesInvoice: {
        findUnique: async () => mockInvoice,
      },
      ewayBill: {
        findFirst: async () => null,
      },
    };

    await expect(
      createSplitBills(mockTxWithDoc, { user: { id: 'u1' } }, {
        sourceType: 'SALES_INVOICE',
        sourceId: 'inv-1',
        dispatchGstin: MH_GSTIN,
        vehicles: [
          { vehicleNo: 'MH12AB1234', quantity: 60 },
          { vehicleNo: 'MH12CD5678', quantity: 50 },
        ],
      })
    ).rejects.toThrow('Total assigned quantity (110) does not match the invoice predefined goods quantity (100)');
  });
});

