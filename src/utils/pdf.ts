import QRCode from 'qrcode';

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

// Draws a QR code as vector squares (the PDF is written by hand, so no image is embedded). (x, y) is the bottom-left corner.
function qrOps(value: string, x: number, y: number, size: number) {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'L' });
  const count = qr.modules.size;
  const cell = size / count;
  const data = qr.modules.data as unknown as ArrayLike<number>;
  const rects: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (data[row * count + col]) rects.push(`${(x + col * cell).toFixed(2)} ${(y + (count - 1 - row) * cell).toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re`);
    }
  }
  return `0 0 0 rg ${rects.join(' ')} f 0 0 0 rg`;
}

const istStamp = (value: any) => {
  const date = new Date(new Date(value).getTime() + 5.5 * 3600 * 1000);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} IST`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Tax invoice. Same look as the e-way bill print: a coloured title band, boxed sections, tax breakup, and, when the
// invoice has a generated e-invoice, the IRN, acknowledgement and the signed QR.
// ---------------------------------------------------------------------------------------------------------------------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// Indian grouping: crore, lakh, thousand.
function numberWords(value: number): string {
  let n = Math.floor(value);
  if (n === 0) return 'Zero';
  const two = (x: number) => (x < 20 ? ONES[x] : `${TENS[Math.floor(x / 10)]}${x % 10 ? ` ${ONES[x % 10]}` : ''}`);
  const three = (x: number) => `${x >= 100 ? `${ONES[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' : ''}` : ''}${x % 100 ? two(x % 100) : ''}`;
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${numberWords(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return parts.join(' ');
}

export function amountInWords(value: number): string {
  const total = Math.round(Math.abs(value) * 100);
  const rupees = Math.floor(total / 100);
  const paise = total % 100;
  return `Rupees ${numberWords(rupees)}${paise ? ` and ${numberWords(paise)} Paise` : ''} Only`;
}

// Everything printed besides the invoice itself: the company, the buyer, the ship-to address and the place of supply.
export type InvoicePdfParties = {
  seller?: { name?: string | null; gstin?: string | null; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; phone?: string | null; email?: string | null } | null;
  buyer?: { name?: string | null; gstin?: string | null; address?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; zip?: string | null; phone?: string | null } | null;
  shipTo?: { name?: string | null; gstin?: string | null; address?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; zip?: string | null } | null;
  placeOfSupply?: string | null;
  hsnByProduct?: Record<string, string | null | undefined>;
};

type EInvoiceForPdf = { irn?: string | null; ackNo?: string | null; ackDate?: any; signedQr?: string | null; sellerGstin?: string | null; placeOfSupply?: string | null } | null | undefined;

export function renderInvoicePdf(invoice: any, printFormat?: any, einvoice?: EInvoiceForPdf, parties: InvoicePdfParties = {}) {
  const template = printFormat?.template || {};
  const title = String(template.title || 'Tax Invoice');
  const currency = String(invoice.currency || 'INR');
  const isInr = currency.toUpperCase() === 'INR';
  const pages: string[][] = [[]];
  let ops = pages[0];
  const PAGE_H = 842;
  const L = 36; const R = 559; const W = R - L;
  const BOTTOM = 780;
  const clean = (value: any) => String(value ?? '').replace(/[^\x20-\x7E]/g, '?');
  const color = (c: number[]) => `${c[0]} ${c[1]} ${c[2]}`;
  const BLACK = [0.1, 0.1, 0.1]; const GREY = [0.42, 0.45, 0.5]; const GREEN = [0.06, 0.46, 0.43]; const RED = [0.7, 0.15, 0.15];

  const text = (x: number, top: number, size: number, value: any, opts: { bold?: boolean; align?: 'left' | 'right'; color?: number[] } = {}) => {
    const str = clean(value);
    const left = opts.align === 'right' ? x - textWidth(str, size, opts.bold) : x;
    ops.push(`BT /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${color(opts.color || BLACK)} rg ${left.toFixed(1)} ${(PAGE_H - top).toFixed(1)} Td (${esc(str)}) Tj ET`);
  };
  const box = (x: number, top: number, w: number, h: number) => ops.push(`0.78 0.8 0.83 RG 0.6 w ${x} ${PAGE_H - top - h} ${w} ${h} re S`);
  const band = (x: number, top: number, w: number, h: number, fill: number[]) => ops.push(`${color(fill)} rg ${x} ${PAGE_H - top - h} ${w} ${h} re f`);
  const rule = (x1: number, x2: number, top: number) => ops.push(`0.86 0.88 0.9 RG 0.5 w ${x1} ${PAGE_H - top} m ${x2} ${PAGE_H - top} l S`);
  const vrule = (x: number, top: number, h: number) => ops.push(`0.86 0.88 0.9 RG 0.5 w ${x} ${PAGE_H - top} m ${x} ${PAGE_H - top - h} l S`);
  const money = (value: any) => `${isInr ? 'INR' : currency} ${amount(value)}`;
  const num = (value: any) => Number(value && typeof value.toNumber === 'function' ? value.toNumber() : value || 0);
  const stateLine = (code?: string | null, name?: string | null) => {
    const label = name || (code && STATE_CODES[code]) || '';
    return code ? `State ${code}${label ? ` (${label})` : ''}` : label;
  };

  let top = 36;
  const newPage = () => {
    ops = [];
    pages.push(ops);
    band(L, 36, W, 24, GREEN);
    text(L + 12, 52, 11, `${title}  ${invoice.invoiceNo} (continued)`, { bold: true, color: [1, 1, 1] });
    top = 74;
  };
  const ensure = (height: number) => { if (top + height > BOTTOM) newPage(); };

  // Title band: document name, number and status
  band(L, top, W, 40, GREEN);
  text(L + 14, top + 26, 18, title, { bold: true, color: [1, 1, 1] });
  text(R - 14, top + 16, 8, 'INVOICE NO.', { align: 'right', color: [0.85, 0.95, 0.93] });
  text(R - 14, top + 31, 12, invoice.invoiceNo, { bold: true, align: 'right', color: [1, 1, 1] });
  top += 40;
  if (invoice.status === 'CANCELLED') { text(L + 14, top + 14, 9, 'CANCELLED', { bold: true, color: RED }); top += 4; }
  top += 8;

  // Date, due date, place of supply
  const posCode = einvoice?.placeOfSupply || parties.placeOfSupply || parties.buyer?.stateCode || null;
  const cell = (index: number, count: number, label: string, value: string, y: number, big = false) => {
    const w = W / count; const x = L + index * w;
    text(x + 10, y + 15, 7.5, label.toUpperCase(), { color: GREY });
    text(x + 10, y + 32, big ? 12 : 10, value, { bold: true });
  };
  const showTerms = template.showPaymentTerms !== false;
  const cells: Array<[string, string]> = [['Invoice date', istDate(invoice.date)]];
  if (showTerms) cells.push(['Due date', invoice.dueDate ? istDate(invoice.dueDate) : '-']);
  cells.push(['Place of supply', stateLine(posCode) || '-']);
  if (invoice.salesOrder?.orderNo) cells.push(['Sales order', invoice.salesOrder.orderNo]);
  box(L, top, W, 46);
  cells.forEach(([label, value], index) => { if (index) vrule(L + (W / cells.length) * index, top, 46); cell(index, cells.length, label, value, top); });
  top += 46 + 10;

  // E-invoice: IRN, acknowledgement and the signed QR
  if (einvoice?.signedQr && einvoice?.irn) {
    const h = 112;
    box(L, top, W, h);
    text(L + 12, top + 17, 10, 'E-Invoice', { bold: true, color: GREEN });
    rule(L + 12, R - 120, top + 23);
    const irn = String(einvoice.irn);
    text(L + 12, top + 40, 8.5, `IRN: ${irn.slice(0, 32)}`, { bold: true });
    text(L + 12, top + 52, 8.5, `     ${irn.slice(32)}`, { bold: true });
    text(L + 12, top + 70, 9, `Ack No: ${einvoice.ackNo || ''}`);
    text(L + 12, top + 84, 9, `Ack Date: ${einvoice.ackDate ? istStamp(einvoice.ackDate) : ''}`);
    text(L + 12, top + 100, 7.5, 'Registered on the e-invoice portal. Scan the QR to verify.', { color: GREY });
    ops.push(qrOps(einvoice.signedQr, R - 104, PAGE_H - top - 8 - 96, 96));
    top += h + 10;
  }

  // Seller and buyer (and ship-to)
  const seller = { ...parties.seller, gstin: einvoice?.sellerGstin || parties.seller?.gstin };
  const party = (x: number, w: number, y: number, label: string, p: any, height: number) => {
    box(x, y, w, height);
    text(x + 12, y + 16, 9, label, { bold: true, color: GREEN });
    rule(x + 12, x + w - 12, y + 22);
    text(x + 12, y + 37, 10, wrapText(p?.name || '-', w - 24, 10, 1, true)[0], { bold: true });
    text(x + 12, y + 50, 8.5, `GSTIN ${p?.gstin || '-'}`, { color: GREY });
    wrapText(p?.address || '', w - 24, 8.5, 2).forEach((line, i) => text(x + 12, y + 63 + i * 11, 8.5, line));
    text(x + 12, y + 87, 8.5, [p?.city, p?.zip].filter(Boolean).join(' '));
    text(x + 12, y + 99, 8, stateLine(p?.stateCode || (p?.gstin ? String(p.gstin).slice(0, 2) : null), p?.state), { color: GREY });
  };
  // Seller and bill-to side by side; a ship-to address makes it three columns.
  const columns = parties.shipTo ? 3 : 2;
  const gap = 10;
  const colW = (W - gap * (columns - 1)) / columns;
  ensure(116);
  party(L, colW, top, 'Seller', seller, 108);
  party(L + colW + gap, colW, top, 'Bill to', parties.buyer || { name: invoice.customer?.name }, 108);
  if (parties.shipTo) party(L + 2 * (colW + gap), colW, top, 'Ship to', parties.shipTo, 108);
  top += 108 + 10;

  // Items
  const tableHead = () => {
    band(L, top, W, 20, [0.94, 0.95, 0.96]);
    const head = (x: number, label: string, align: 'left' | 'right' = 'left') => text(x, top + 13.5, 7.5, label.toUpperCase(), { bold: true, align, color: GREY });
    head(L + 8, '#'); head(L + 26, 'Description'); head(L + 212, 'HSN/SAC'); head(L + 296, 'Qty', 'right'); head(L + 352, 'Rate', 'right'); head(L + 420, 'Taxable', 'right'); head(L + 458, 'Tax %', 'right'); head(R - 8, 'Amount', 'right');
    top += 20;
  };
  ensure(60);
  tableHead();
  const items = invoice.items || [];
  const rowH = 26;
  items.forEach((item: any, index: number) => {
    if (top + rowH > BOTTOM) { newPage(); tableHead(); }
    const name = item.description || item.product?.name || item.itemCode || '';
    const hsn = item.hsnCode || parties.hsnByProduct?.[item.productId] || item.product?.hsnCode || '';
    text(L + 8, top + 12, 9, index + 1);
    text(L + 26, top + 12, 9, wrapText(name, 175, 9, 1, true)[0] || '', { bold: true });
    text(L + 26, top + 22, 7.5, item.itemCode || item.product?.sku || '', { color: GREY });
    text(L + 212, top + 12, 9, hsn);
    text(L + 296, top + 12, 9, num(item.quantity).toString().replace(/\.0+$/, ''), { align: 'right' });
    text(L + 352, top + 12, 9, amount(item.rate ?? item.unitPrice), { align: 'right' });
    text(L + 420, top + 12, 9, amount(item.netAmount), { align: 'right' });
    text(L + 458, top + 12, 9, num(item.taxRate).toFixed(2), { align: 'right' });
    text(R - 8, top + 12, 9, amount(item.total), { align: 'right' });
    top += rowH;
    rule(L, R, top);
  });
  // frame around the table body on each page it spans is kept simple: a rule under every row is enough.
  top += 12;

  // HSN summary (left) and totals (right)
  const rightW = 240;
  const rx = R - rightW;
  const leftW = rx - L - 14;
  const taxRows: Array<{ label: string; amount: number }> = [];
  for (const tax of invoice.taxes || []) {
    const existing = taxRows.find((row) => row.label === tax.label);
    if (existing) existing.amount += num(tax.taxAmount); else taxRows.push({ label: String(tax.label), amount: num(tax.taxAmount) });
  }
  if (!taxRows.length && num(invoice.taxAmount) > 0) taxRows.push({ label: 'Tax', amount: num(invoice.taxAmount) });
  const discount = num(invoice.discount);
  const rounding = num(invoice.roundingAdjustment);
  const paid = num(invoice.amountPaid);
  const totalLines = 1 + taxRows.length + (discount ? 1 : 0) + (rounding ? 1 : 0) + (paid > 0 ? 2 : 0);
  const totalsH = 44 + totalLines * 14;

  const hsnRows = new Map<string, { taxable: number; tax: number; rate: number }>();
  if (template.showHsnSummary !== false) {
    for (const item of items) {
      const hsn = item.hsnCode || parties.hsnByProduct?.[item.productId] || item.product?.hsnCode;
      if (!hsn) continue;
      const row = hsnRows.get(hsn) || { taxable: 0, tax: 0, rate: num(item.taxRate) };
      row.taxable += num(item.netAmount); row.tax += num(item.taxAmount);
      hsnRows.set(hsn, row);
    }
  }
  const hsnList = Array.from(hsnRows.entries()).slice(0, 8);
  const words = template.showAmountInWords !== false && isInr ? wrapText(amountInWords(num(invoice.grandTotal)), leftW - 24, 9, 3, true) : [];
  const leftH = (words.length ? 28 + words.length * 12 : 0) + (hsnList.length ? 34 + hsnList.length * 15 : 0);
  ensure(Math.max(totalsH, leftH) + 10);

  // totals
  box(rx, top, rightW, totalsH);
  text(rx + 12, top + 16, 9, 'Summary', { bold: true, color: GREEN });
  rule(rx + 12, R - 12, top + 22);
  let y = top + 38;
  const line = (label: string, value: number, strong = false) => { text(rx + 12, y, 9, label, { color: strong ? BLACK : GREY, bold: strong }); text(R - 12, y, 9, money(value), { align: 'right', bold: strong }); y += 14; };
  line('Taxable value', num(invoice.subtotal));
  taxRows.forEach((row) => line(row.label, row.amount));
  if (discount) line('Discount', -discount);
  if (rounding) line('Round off', rounding);
  rule(rx + 12, R - 12, y - 6);
  y += 4;
  text(rx + 12, y, 10, 'Grand total', { bold: true });
  text(R - 12, y, 11, money(invoice.grandTotal), { bold: true, align: 'right' });
  y += 14;
  if (paid > 0) { line('Paid', paid); line('Outstanding', num(invoice.outstandingAmount), true); }

  // amount in words, HSN summary
  let ly = top;
  if (words.length) {
    box(L, ly, leftW, 28 + words.length * 12);
    text(L + 12, ly + 16, 9, 'Amount in words', { bold: true, color: GREEN });
    words.forEach((w, i) => text(L + 12, ly + 32 + i * 12, 9, w, { bold: true }));
    ly += 28 + words.length * 12 + 6;
  }
  if (hsnList.length) {
    const h = 34 + hsnList.length * 15;
    box(L, ly, leftW, h);
    text(L + 12, ly + 16, 9, 'HSN summary', { bold: true, color: GREEN });
    const hy = ly + 30;
    text(L + 12, hy, 7.5, 'HSN/SAC', { bold: true, color: GREY }); text(L + leftW * 0.5, hy, 7.5, 'TAXABLE', { bold: true, color: GREY, align: 'right' });
    text(L + leftW * 0.72, hy, 7.5, 'RATE %', { bold: true, color: GREY, align: 'right' }); text(L + leftW - 10, hy, 7.5, 'TAX', { bold: true, color: GREY, align: 'right' });
    hsnList.forEach(([hsn, row], i) => {
      const ry = hy + 14 + i * 15 - 3;
      text(L + 12, ry + 2, 8.5, hsn); text(L + leftW * 0.5, ry + 2, 8.5, amount(row.taxable), { align: 'right' });
      text(L + leftW * 0.72, ry + 2, 8.5, row.rate.toFixed(2), { align: 'right' }); text(L + leftW - 10, ry + 2, 8.5, amount(row.tax), { align: 'right' });
    });
    ly += h + 6;
  }
  top += Math.max(totalsH, ly - top) + 12;

  // terms and notes
  const noteText = [invoice.terms ? `Terms: ${invoice.terms}` : '', invoice.notes ? `Notes: ${invoice.notes}` : ''].filter(Boolean).join('   ');
  if (showTerms && noteText) {
    const noteLines = wrapText(noteText, W - 24, 8.5, 4);
    ensure(24 + noteLines.length * 11);
    box(L, top, W, 24 + noteLines.length * 11);
    text(L + 12, top + 15, 9, 'Terms and notes', { bold: true, color: GREEN });
    noteLines.forEach((l, i) => text(L + 12, top + 30 + i * 11, 8.5, l));
    top += 24 + noteLines.length * 11 + 10;
  }

  // signature and footer
  ensure(70);
  text(R - 12, top + 14, 9, `For ${seller.name || ''}`, { bold: true, align: 'right' });
  rule(R - 170, R - 12, top + 54);
  text(R - 12, top + 66, 8, 'Authorised signatory', { align: 'right', color: GREY });
  if (printFormat?.footer) text(L, top + 66, 8, wrapText(printFormat.footer, 300, 8, 1)[0], { color: GREY });

  // page numbers
  pages.forEach((pageOps, index) => {
    ops = pageOps;
    text(L, 826, 7.5, 'Computer generated invoice', { color: GREY });
    text(R, 826, 7.5, `Page ${index + 1} of ${pages.length}`, { align: 'right', color: GREY });
  });
  return pdfFromPages(pages.map((p) => p.join('\n')));
}

// One PDF with a page per stream.
function pdfFromPages(streams: string[]) {
  const pageObject = (i: number) => 5 + i * 2;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] /Count ${streams.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  streams.forEach((stream, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObject(i) + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
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
