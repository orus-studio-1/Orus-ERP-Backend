import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ recordAuditEvent: vi.fn(), tx: {} as any }));

vi.mock('../../lib/prisma', () => ({ default: { $transaction: (fn: any) => fn(h.tx) } }));
vi.mock('../../middleware/platform', () => ({ recordAuditEvent: h.recordAuditEvent, setAuditContext: vi.fn() }));
vi.mock('../../services/inventory/stockLedger.service', () => ({ postStockLedger: vi.fn() }));
vi.mock('../../services/inventory/reservation.service', () => ({ fulfillSalesOrderReservation: vi.fn() }));
vi.mock('../../services/sales/salesOrder.service', () => ({ markSalesOrderBilled: vi.fn(), refreshSalesOrderProgress: vi.fn() }));
vi.mock('./shared', () => ({ invoiceInclude: {}, invoiceResponse: (invoice: any) => invoice, postInvoiceLedger: vi.fn() }));

import { amendInvoice } from './salesInvoiceLifecycle.controller';

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
};

beforeEach(() => {
  h.recordAuditEvent.mockReset();
  h.tx = {
    $executeRawUnsafe: vi.fn(),
    salesInvoice: {
      findUnique: vi.fn(async () => ({ id: 'orig', invoiceNo: 'INV-1', status: 'CANCELLED', items: [], grandTotal: 0, currency: 'INR' })),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'new', invoiceNo: 'INV-1-1' })),
    },
  };
});

describe('amending an invoice', () => {
  it('records an AMEND event on the new draft and on the original, both through the same transaction', async () => {
    const res = makeRes();
    await amendInvoice({ params: { id: 'orig' }, body: {} } as any, res);
    expect(res.statusCode).toBe(201);
    const calls = h.recordAuditEvent.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every(([tx]) => tx === h.tx)).toBe(true);
    expect(calls.map(([, , event]) => [event.entityType, event.entityId, event.action])).toEqual([
      ['SALES_INVOICE', 'new', 'AMEND'],
      ['SALES_INVOICE', 'orig', 'AMEND'],
    ]);
  });

  it('fails the whole amendment when the audit entry cannot be recorded', async () => {
    h.recordAuditEvent.mockRejectedValueOnce(new Error('audit insert failed'));
    const res = makeRes();
    await amendInvoice({ params: { id: 'orig' }, body: {} } as any, res);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });
});
