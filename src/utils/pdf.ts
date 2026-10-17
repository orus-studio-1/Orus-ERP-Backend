function esc(value: any) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function money(value: any, currency = 'USD') {
  const amount = value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value || 0);
  return `${currency} ${amount.toFixed(2)}`;
}

function textLine(x: number, y: number, size: number, text: string) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET`;
}

export function renderInvoicePdf(invoice: any, printFormat?: any) {
  const template = printFormat?.template || {};
  const title = template.title || 'Tax Invoice';
  const lines: string[] = [];
  let y = 790;

  lines.push(textLine(48, y, 18, title));
  y -= 26;
  lines.push(textLine(48, y, 11, `Invoice: ${invoice.invoiceNo}`));
  lines.push(textLine(360, y, 11, `Date: ${new Date(invoice.date).toISOString().slice(0, 10)}`));
  y -= 18;
  lines.push(textLine(48, y, 11, `Customer: ${invoice.customer?.name || invoice.customerId}`));
  lines.push(textLine(360, y, 11, `Status: ${invoice.status}`));
  y -= 24;
  lines.push(textLine(48, y, 12, 'Items'));
  y -= 16;
  lines.push(textLine(48, y, 9, 'Code'));
  lines.push(textLine(125, y, 9, 'Description'));
  lines.push(textLine(330, y, 9, 'Qty'));
  lines.push(textLine(385, y, 9, 'Rate'));
  lines.push(textLine(455, y, 9, 'Amount'));
  y -= 12;

  for (const item of invoice.items || []) {
    if (y < 120) break;
    lines.push(textLine(48, y, 9, item.itemCode || item.product?.sku || ''));
    lines.push(textLine(125, y, 9, String(item.description || item.product?.name || '').slice(0, 34)));
    lines.push(textLine(330, y, 9, Number(item.quantity || 0).toString()));
    lines.push(textLine(385, y, 9, money(item.rate || item.unitPrice, invoice.currency)));
    lines.push(textLine(455, y, 9, money(item.total, invoice.currency)));
    y -= 14;
  }

  y -= 16;
  lines.push(textLine(360, y, 10, `Subtotal: ${money(invoice.subtotal, invoice.currency)}`));
  y -= 15;
  lines.push(textLine(360, y, 10, `Tax: ${money(invoice.taxAmount, invoice.currency)}`));
  y -= 15;
  lines.push(textLine(360, y, 12, `Grand Total: ${money(invoice.grandTotal, invoice.currency)}`));
  y -= 22;
  if (invoice.terms) lines.push(textLine(48, y, 9, `Terms: ${String(invoice.terms).slice(0, 95)}`));
  if (printFormat?.footer) lines.push(textLine(48, 42, 8, printFormat.footer));

  const stream = lines.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function pdfFromStream(stream: string) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}


import { STATE_CODES } from '../services/eway/ewayRules.service';

const amount = (value: any) => (value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value || 0)).toFixed(2);

// Indian time, as the portal shows it, whatever the server's own time zone is.
const IST_MS = 5.5 * 3600 * 1000;
const ist = (value: any) => new Date(new Date(value).getTime() + IST_MS);
const pad = (n: number) => String(n).padStart(2, '0');
const istDate = (value: any) => { if (!value) return '-'; const d = ist(value); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const istDateTime = (value: any) => { if (!value) return '-'; const d = ist(value); return `${istDate(value)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

// Helvetica widths (per 1000 units) are close enough to this to right-align numbers and wrap text.
function textWidth(text: string, size: number, bold = false) {
  let units = 0;
  for (const ch of text) {
    if (ch === ' ' || /[.,:;'|!]/.test(ch)) units += 278;
    else if (/[ijl]/.test(ch)) units += 222;
    else if (/[frt]/.test(ch)) units += 333;
    else if (/[mwMW]/.test(ch)) units += 833;
    else if (/[A-Z]/.test(ch)) units += 667;
    else units += 556;
  }
  return (units / 1000) * size * (bold ? 1.06 : 1);
}

function wrapText(text: string, width: number, size: number, maxLines: number, bold = false) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, bold) <= width || !line) line = next; else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = `${out[maxLines - 1].slice(0, -1)}...`; }
  return out;
}

const DOC_NAMES: Record<string, string> = { INV: 'Tax Invoice', CHL: 'Delivery Challan', BIL: 'Bill of Supply', BOE: 'Bill of Entry', OTH: 'Other' };
const SUB_SUPPLY: Record<number, string> = { 1: 'Supply', 2: 'Import', 3: 'Export', 4: 'Job work', 5: 'For own use', 8: 'Others', 9: 'SKD/CKD', 10: 'Line sales', 11: 'Recipient not known', 12: 'Exhibition or fairs' };

// Printed copy of a recorded e-way bill. The number and validity are the ones the portal returned; this is the
// ERP's own copy for the driver and the file, not the portal's official print.
export function renderEwayBillPdf(bill: any) {
  const ops: string[] = [];
  const PAGE_H = 842;
  const L = 40; const R = 555; const W = R - L;
  const clean = (value: any) => String(value ?? '').replace(/[^\x20-\x7E]/g, '?');
  const color = (c: number[]) => `${c[0]} ${c[1]} ${c[2]}`;
  const BLACK = [0.1, 0.1, 0.1]; const GREY = [0.42, 0.45, 0.5]; const GREEN = [0.06, 0.46, 0.43];

  // top-based y: the PDF origin is the bottom-left corner.
  const text = (x: number, top: number, size: number, value: any, opts: { bold?: boolean; align?: 'left' | 'right'; color?: number[] } = {}) => {
    const str = clean(value);
    const left = opts.align === 'right' ? x - textWidth(str, size, opts.bold) : x;
    ops.push(`BT /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${color(opts.color || BLACK)} rg ${left.toFixed(1)} ${(PAGE_H - top).toFixed(1)} Td (${esc(str)}) Tj ET`);
  };
  const box = (x: number, top: number, w: number, h: number) => {
    ops.push(`0.78 0.8 0.83 RG 0.6 w ${x} ${PAGE_H - top - h} ${w} ${h} re S`);
  };
  const band = (x: number, top: number, w: number, h: number, fill: number[]) => ops.push(`${color(fill)} rg ${x} ${PAGE_H - top - h} ${w} ${h} re f`);
  const rule = (x1: number, x2: number, top: number) => ops.push(`0.86 0.88 0.9 RG 0.5 w ${x1} ${PAGE_H - top} m ${x2} ${PAGE_H - top} l S`);
  const vrule = (x: number, top: number, h: number) => ops.push(`0.86 0.88 0.9 RG 0.5 w ${x} ${PAGE_H - top} m ${x} ${PAGE_H - top - h} l S`);

  // Title and status
  band(L, 40, W, 38, GREEN);
  text(L + 14, 66, 20, 'E-Way Bill', { bold: true, color: [1, 1, 1] });
  text(R - 14, 55, 8, 'STATUS', { align: 'right', color: [0.85, 0.95, 0.93] });
  text(R - 14, 70, 11, String(bill.status || '-'), { bold: true, align: 'right', color: [1, 1, 1] });

  // Number, generation and validity
  const cell = (index: number, label: string, value: string, top: number, big = false) => {
    const w = W / 3; const x = L + index * w;
    text(x + 12, top + 16, 8, label.toUpperCase(), { color: GREY });
    text(x + 12, top + 34, big ? 15 : 11, value, { bold: true });
  };
  box(L, 92, W, 50); vrule(L + W / 3, 92, 50); vrule(L + (2 * W) / 3, 92, 50);
  cell(0, 'E-way bill no.', String(bill.ewbNo || '-'), 92, true);
  cell(1, 'Generated on', istDateTime(bill.ewbDate), 92);
  cell(2, 'Valid until', istDateTime(bill.validUntil), 92);

  // Document
  box(L, 150, W, 44); vrule(L + W / 3, 150, 44); vrule(L + (2 * W) / 3, 150, 44);
  cell(0, 'Document', `${DOC_NAMES[bill.docType] || bill.docType} ${bill.docNo}`, 142);
  cell(1, 'Document date', istDate(bill.docDate), 142);
  cell(2, 'Supply type', `Outward - ${SUB_SUPPLY[bill.subSupplyType] || bill.subSupplyType}`, 142);

  // Parties
  const stateLine = (code: string | null) => (code ? `State ${code}${STATE_CODES[code] ? ` (${STATE_CODES[code]})` : ''}` : '');
  const party = (x: number, w: number, title: string, name: any, gstin: any, a1: any, a2: any, pl: any, pin: any, state: any) => {
    box(x, 206, w, 112);
    text(x + 12, 222, 10, title, { bold: true, color: GREEN });
    rule(x + 12, x + w - 12, 228);
    text(x + 12, 243, 10, name || '-', { bold: true });
    text(x + 12, 256, 9, `GSTIN ${gstin || '-'}`, { color: GREY });
    wrapText([a1, a2].filter(Boolean).join(', '), w - 24, 9, 2).forEach((line, i) => text(x + 12, 271 + i * 12, 9, line));
    text(x + 12, 298, 9, [pl, pin].filter(Boolean).join(' '));
    text(x + 12, 310, 8, stateLine(state), { color: GREY });
  };
  const half = (W - 14) / 2;
  party(L, half, 'Dispatch from', bill.fromName, bill.fromGstin, bill.fromAddr1, bill.fromAddr2, bill.fromPlace, bill.fromPincode, bill.fromStateCode);
  party(L + half + 14, half, 'Deliver to', bill.toName, bill.toGstin, bill.toAddr1, bill.toAddr2, bill.toPlace, bill.toPincode, bill.actualToStateCode || bill.toStateCode);

  // Items
  // Items
  const tableTop = 332;
  let top = tableTop;
  band(L, top, W, 20, [0.94, 0.95, 0.96]);
  const head = (x: number, label: string, align: 'left' | 'right' = 'left') => text(x, top + 14, 8, label.toUpperCase(), { bold: true, align, color: GREY });
  head(L + 8, '#'); head(L + 32, 'HSN'); head(L + 92, 'Product'); head(R - 150, 'Qty', 'right'); head(R - 82, 'Taxable', 'right'); head(R - 8, 'Tax %', 'right');
  top += 20;
  const items = bill.items || [];
  const totalDocQty = items.reduce((sum: number, it: any) => sum + Number(it.quantity || 0), 0);
  const isSplit = bill.splitQuantity != null && Number(bill.splitQuantity) > 0 && totalDocQty > 0;
  const ratio = isSplit ? Number(bill.splitQuantity) / totalDocQty : 1;
  const MAX_ITEMS = 9;
  items.slice(0, MAX_ITEMS).forEach((item: any, index: number) => {
    const taxRate = Number(item.cgstRate || 0) + Number(item.sgstRate || 0) + Number(item.igstRate || 0) + Number(item.cessRate || 0);
    const itemQty = isSplit ? Math.round(Number(item.quantity) * ratio * 100) / 100 : Number(item.quantity);
    const itemTaxable = isSplit ? Math.round(Number(item.taxableAmount) * ratio * 100) / 100 : Number(item.taxableAmount);
    text(L + 8, top + 13, 9, index + 1);
    text(L + 32, top + 13, 9, item.hsnCode);
    text(L + 92, top + 13, 9, wrapText(item.productName, 190, 9, 1)[0] || '');
    text(R - 150, top + 13, 9, `${itemQty} ${item.qtyUnit}`, { align: 'right' });
    text(R - 82, top + 13, 9, amount(itemTaxable), { align: 'right' });
    text(R - 8, top + 13, 9, taxRate.toFixed(2), { align: 'right' });
    top += 20; rule(L, R, top);
  });
  if (items.length > MAX_ITEMS) { text(L + 8, top + 13, 8, `+ ${items.length - MAX_ITEMS} more items, see the e-way bill page`, { color: GREY }); top += 18; }
  box(L, tableTop, W, top - tableTop);

  // Transport (left) and totals (right)
  const blockTop = top + 14;
  const tw = 270;
  box(L, blockTop, tw, 128);
  text(L + 12, blockTop + 16, 10, 'Transport (Part B)', { bold: true, color: GREEN });
  rule(L + 12, L + tw - 12, blockTop + 22);
  const kv = (y: number, label: string, value: any) => { text(L + 12, y, 9, label, { color: GREY }); text(L + 90, y, 9, value, { bold: true }); };
  const vehicle = [bill.vehicleNo, bill.vehicleNo ? (bill.vehicleType === 'O' ? '(over-dimensional)' : '(regular)') : ''].filter(Boolean).join(' ');
  kv(blockTop + 38, 'Mode', bill.transportMode);
  kv(blockTop + 53, 'Distance', `${bill.distanceKm || 0} km${bill.distanceKm ? '' : ' (portal calculated)'}`);
  kv(blockTop + 68, 'Vehicle', vehicle || '-');
  if (isSplit) {
    kv(blockTop + 83, 'Consignment Qty', `${bill.splitQuantity} of ${totalDocQty} units (Split)`);
    kv(blockTop + 98, 'Transporter', bill.transporterName || '-');
    kv(blockTop + 113, 'Transporter ID', bill.transporterId || '-');
  } else {
    kv(blockTop + 83, 'Transporter', bill.transporterName || '-');
    kv(blockTop + 98, 'Transporter ID', bill.transporterId || '-');
    kv(blockTop + 113, 'Transport doc', [bill.transportDocNo, bill.transportDocDate ? istDate(bill.transportDocDate) : ''].filter(Boolean).join(' / ') || '-');
  }

  const tx = L + tw + 14;
  box(tx, blockTop, R - tx, 128);
  text(tx + 12, blockTop + 16, 10, isSplit ? 'Consignment Values (INR)' : 'Values (INR)', { bold: true, color: GREEN });
  rule(tx + 12, R - 12, blockTop + 22);
  const money2 = (y: number, label: string, value: any) => { text(tx + 12, y, 9, label, { color: GREY }); text(R - 12, y, 9, amount(value), { align: 'right' }); };
  const taxableVal = isSplit ? Math.round(Number(bill.taxableValue) * ratio * 100) / 100 : bill.taxableValue;
  const cgstVal = isSplit ? Math.round(Number(bill.cgstValue) * ratio * 100) / 100 : bill.cgstValue;
  const sgstVal = isSplit ? Math.round(Number(bill.sgstValue) * ratio * 100) / 100 : bill.sgstValue;
  const igstVal = isSplit ? Math.round(Number(bill.igstValue) * ratio * 100) / 100 : bill.igstValue;
  const cessVal = isSplit ? Math.round(Number(bill.cessValue) * ratio * 100) / 100 : bill.cessValue;
  const otherVal = isSplit ? Math.round(Number(bill.otherValue) * ratio * 100) / 100 : bill.otherValue;
  const totalVal = isSplit ? Math.round(Number(bill.totalValue) * ratio * 100) / 100 : bill.totalValue;

  money2(blockTop + 38, 'Taxable value', taxableVal);
  money2(blockTop + 51, 'CGST', cgstVal);
  money2(blockTop + 64, 'SGST', sgstVal);
  money2(blockTop + 77, 'IGST', igstVal);
  money2(blockTop + 90, 'Cess', cessVal);
  money2(blockTop + 103, 'Other', otherVal);
  rule(tx + 12, R - 12, blockTop + 108);
  text(tx + 12, blockTop + 122, 10, isSplit ? 'Consignment value' : 'Total invoice value', { bold: true });
  text(R - 12, blockTop + 122, 11, amount(totalVal), { bold: true, align: 'right' });

  // Vehicle history (only when the vehicle was changed)
  top = blockTop + 128 + 14;
  const changes = (bill.events || []).filter((e: any) => e.type === 'VEHICLE_UPDATED').sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (changes.length) {
    const rows = [
      { vehicle: changes[0].data?.previousVehicleNo, place: '-', reason: 'Original vehicle', at: bill.ewbDate },
      ...changes.map((e: any) => ({ vehicle: e.data?.vehicleNo, place: [e.data?.fromPlace, e.data?.fromState].filter(Boolean).join(', ') || '-', reason: [e.data?.reason, e.data?.remarks].filter(Boolean).join(' - ') || '-', at: e.createdAt })),
    ].slice(-5);
    text(L, top + 10, 10, 'Vehicle changes', { bold: true, color: GREEN });
    top += 16;
    const historyTop = top;
    band(L, top, W, 18, [0.94, 0.95, 0.96]);
    text(L + 8, top + 12, 8, 'VEHICLE', { bold: true, color: GREY }); text(L + 130, top + 12, 8, 'CHANGED AT', { bold: true, color: GREY });
    text(L + 250, top + 12, 8, 'REASON', { bold: true, color: GREY }); text(R - 8, top + 12, 8, 'WHEN', { bold: true, color: GREY, align: 'right' });
    top += 18;
    rows.forEach((row, index) => {
      text(L + 8, top + 13, 9, row.vehicle || '-', { bold: index === rows.length - 1 });
      text(L + 130, top + 13, 9, wrapText(row.place, 110, 9, 1)[0] || '-');
      text(L + 250, top + 13, 9, wrapText(row.reason, 170, 9, 1)[0] || '-');
      text(R - 8, top + 13, 9, istDateTime(row.at), { align: 'right' });
      top += 18; rule(L, R, top);
    });
    box(L, historyTop, W, top - historyTop);
  }

  // Footer
  rule(L, R, 800);
  text(L, 814, 8, 'Printed copy prepared by Orus ERP. The e-way bill on the portal is the official record.', { color: GREY });
  text(R, 814, 8, `Printed ${istDateTime(new Date())} IST`, { color: GREY, align: 'right' });
  return pdfFromStream(ops.join('\n'));
}
