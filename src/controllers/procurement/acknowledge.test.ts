import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  poFind: vi.fn(), poUpdateMany: vi.fn(), rfqSupplierUpdate: vi.fn(), rfqFind: vi.fn(), companyFind: vi.fn(),
  setAuditContext: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: {
    purchaseOrder: { findUnique: db.poFind, updateMany: db.poUpdateMany },
    requestForQuotationSupplier: { update: db.rfqSupplierUpdate },
    requestForQuotation: { findUnique: db.rfqFind },
    company: { findUnique: db.companyFind },
  },
}));
vi.mock('../../middleware/platform', () => ({ recordAuditEvent: vi.fn(), setAuditContext: db.setAuditContext }));
vi.mock('../../services/procurement/procurement.service', () => ({ documentTotals: vi.fn(), nextNo: vi.fn() }));
vi.mock('../../services/procurement/matching.service', () => ({ runThreeWayMatch: vi.fn() }));
vi.mock('../../services/inventory/stockLedger.service', () => ({ postStockLedger: vi.fn() }));
vi.mock('../../utils/generate', () => ({ generatePONo: vi.fn() }));

import { acknowledgePurchaseOrder, acknowledgeRfq } from './completion.controller';

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
};
const makeReq = (body: any = {}) => ({ params: { token: 'tok' }, body }) as any;
const po = { id: 'po1', orderNo: 'PO-1', status: 'CONFIRMED', companyId: 'c1', rfqId: null };

beforeEach(() => {
  Object.values(db).forEach((fn: any) => fn.mockReset());
  db.companyFind.mockResolvedValue({ tenantId: 't1' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('acknowledgePurchaseOrder', () => {
  it('only updates the row while it still has the status that was read, and logs that status as "before"', async () => {
    db.poFind.mockResolvedValueOnce({ status: 'SENT' }).mockResolvedValueOnce(po);
    db.poUpdateMany.mockResolvedValue({ count: 1 });
    const res = makeRes();
    await acknowledgePurchaseOrder(makeReq({ message: 'ok' }), res);
    expect(db.poUpdateMany.mock.calls[0][0].where).toEqual({ publicToken: 'tok', status: 'SENT' });
    expect(db.setAuditContext.mock.calls[0][1]).toMatchObject({ action: 'VENDOR_ACKNOWLEDGED', statusBefore: 'SENT', statusAfter: 'CONFIRMED' });
    expect(res.statusCode).toBe(200);
  });

  it('answers 409 and logs nothing when a concurrent acknowledgement changed the status first', async () => {
    db.poFind.mockResolvedValueOnce({ status: 'SENT' });
    db.poUpdateMany.mockResolvedValue({ count: 0 });
    const res = makeRes();
    await acknowledgePurchaseOrder(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(db.setAuditContext).not.toHaveBeenCalled();
  });

  it('answers 404 only for an unknown token', async () => {
    db.poFind.mockResolvedValueOnce(null);
    const res = makeRes();
    await acknowledgePurchaseOrder(makeReq(), res);
    expect(res.statusCode).toBe(404);
  });

  it('reports a database failure as 500, not as an invalid link', async () => {
    db.poFind.mockRejectedValueOnce(new Error('connection lost'));
    const res = makeRes();
    await acknowledgePurchaseOrder(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.message).not.toMatch(/invalid/i);
  });
});

describe('acknowledgeRfq', () => {
  it('answers 404 for an unknown token (Prisma P2025) but 500 for any other failure', async () => {
    db.rfqSupplierUpdate.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'P2025' }));
    const notFound = makeRes();
    await acknowledgeRfq(makeReq(), notFound);
    expect(notFound.statusCode).toBe(404);

    db.rfqSupplierUpdate.mockRejectedValueOnce(new Error('connection lost'));
    const failed = makeRes();
    await acknowledgeRfq(makeReq(), failed);
    expect(failed.statusCode).toBe(500);
  });
});
