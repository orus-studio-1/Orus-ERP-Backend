import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  platformAuditLog: { findMany: vi.fn(), count: vi.fn() },
  salesInvoice: { findMany: vi.fn() },
  deliveryNote: { findMany: vi.fn() },
  creditNote: { findMany: vi.fn() },
  paymentEntry: { findMany: vi.fn() },
}));
vi.mock('../../lib/prisma', () => ({ default: db }));

import { getAuditLogs } from './auditLog.controller';

const T1 = '0198aaaa-0000-7000-8000-000000000001';

async function call(query: any = {}) {
  const req: any = { query, user: { tenantId: T1, companyId: 'c1' } };
  let status = 200; let body: any;
  const res: any = { status(code: number) { status = code; return this; }, json(value: any) { body = value; return this; } };
  await getAuditLogs(req, res);
  return { status, body };
}

beforeEach(() => {
  Object.values(db).forEach((model: any) => Object.values(model).forEach((fn: any) => fn.mockReset()));
  db.platformAuditLog.count.mockResolvedValue(0);
  db.platformAuditLog.findMany.mockResolvedValue([]);
  Object.entries(db).filter(([name]) => name !== 'platformAuditLog').forEach(([, model]: any) => model.findMany.mockResolvedValue([]));
});

describe('invoicing audit-logs', () => {
  it('reads only the caller\'s tenant and company and only the INVOICING module', async () => {
    await call();
    const where = db.platformAuditLog.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: T1, companyId: 'c1' });
    const prefixes = where.AND[0].OR.map((clause: any) => clause.entityType?.startsWith).filter(Boolean);
    expect(prefixes).toEqual(expect.arrayContaining(['INVOICING:', 'INVOICES:', 'PAYMENTS:', 'DELIVERY-NOTES:']));
    expect(where.AND[0].OR).toContainEqual({ entityType: { in: expect.arrayContaining(['SALES_INVOICE', 'DELIVERY_NOTE', 'CREDIT_NOTE', 'PAYMENT_ENTRY']) } });
  });

  it('applies the page filters: document type, action, search and an inclusive date range', async () => {
    await call({ entityType: 'sales_invoice', action: 'submit', search: 'INV-1', fromDate: '2026-10-01', toDate: '2026-10-07' });
    const where = db.platformAuditLog.findMany.mock.calls[0][0].where;
    expect(where.entityType).toBe('SALES_INVOICE');
    expect(where.action).toBe('SUBMIT');
    expect(where.createdAt.gte).toEqual(new Date('2026-10-01'));
    expect(where.createdAt.lte).toEqual(new Date('2026-10-07T23:59:59.999Z'));
    expect(where.AND[1].OR.map((clause: any) => Object.keys(clause)[0])).toEqual(expect.arrayContaining(['message', 'actorEmail', 'entityId']));
  });

  it('ignores an invalid date instead of failing', async () => {
    const { status } = await call({ fromDate: 'not-a-date' });
    expect(status).toBe(200);
    expect(db.platformAuditLog.findMany.mock.calls[0][0].where.createdAt).toBeUndefined();
  });

  it('pages the result and caps the page size', async () => {
    db.platformAuditLog.count.mockResolvedValue(450);
    const { body } = await call({ page: '3', limit: '5000' });
    expect(db.platformAuditLog.findMany.mock.calls[0][0]).toMatchObject({ skip: 400, take: 200 });
    expect(body.data).toMatchObject({ total: 450, page: 3, limit: 200, totalPages: 3 });
  });

  it('adds the voucher number the page shows, per document type, and leaves other rows alone', async () => {
    db.platformAuditLog.findMany.mockResolvedValue([
      { id: 'a1', entityType: 'SALES_INVOICE', entityId: 'inv1', action: 'SUBMIT' },
      { id: 'a2', entityType: 'DELIVERY_NOTE', entityId: 'dn1', action: 'CREATE' },
      { id: 'a3', entityType: 'CREDIT_NOTE', entityId: 'cn1', action: 'SUBMIT' },
      { id: 'a4', entityType: 'PAYMENT_ENTRY', entityId: 'pe1', action: 'CREATE' },
      { id: 'a5', entityType: 'INVOICES:REQUEST', entityId: 'inv9', action: 'UPDATE' },
    ]);
    db.salesInvoice.findMany.mockResolvedValue([{ id: 'inv1', invoiceNo: 'INV-1' }]);
    db.deliveryNote.findMany.mockResolvedValue([{ id: 'dn1', deliveryNo: 'DN-1' }]);
    db.creditNote.findMany.mockResolvedValue([{ id: 'cn1', creditNoteNo: 'CN-1' }]);
    db.paymentEntry.findMany.mockResolvedValue([{ id: 'pe1', paymentNo: 'PAY-1' }]);
    const { body } = await call();
    const byId = Object.fromEntries(body.data.items.map((item: any) => [item.id, item]));
    expect(byId.a1).toMatchObject({ voucherNo: 'INV-1', invoice: { invoiceNo: 'INV-1' } });
    expect(byId.a2).toMatchObject({ voucherNo: 'DN-1', deliveryNote: { deliveryNo: 'DN-1' } });
    expect(byId.a3).toMatchObject({ voucherNo: 'CN-1', creditNote: { creditNoteNo: 'CN-1' } });
    expect(byId.a4).toMatchObject({ voucherNo: 'PAY-1', paymentEntry: { paymentNo: 'PAY-1' } });
    expect(byId.a5.voucherNo).toBeUndefined();
  });

  it('does not look up document numbers when there are no rows', async () => {
    await call();
    expect(db.salesInvoice.findMany).not.toHaveBeenCalled();
  });
});
