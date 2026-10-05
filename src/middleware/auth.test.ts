import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ allowed: true, order: [] as string[] }));

vi.mock('../lib/prisma', () => ({ default: {} }));
vi.mock('./platform', () => ({
  captureBeforeSnapshot: vi.fn(async () => { state.order.push('snapshot'); }),
}));
vi.mock('../utils/accessControl', () => ({
  computeEffectiveAccess: vi.fn(),
  firstPathSegment: () => 'sales-invoices',
  getActionForRequest: () => 'WRITE',
  hasPermission: () => state.allowed,
}));

import { captureBeforeSnapshot } from './platform';
import { captureAuditBefore, requireModuleAccess, requirePermission } from './auth';

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
};
const req: any = { method: 'PUT', path: '/sales-invoices/inv1', originalUrl: '/api/v1/invoicing/sales-invoices/inv1', access: {} };

beforeEach(() => {
  state.allowed = true;
  state.order = [];
  vi.mocked(captureBeforeSnapshot).mockClear();
});

describe.each([
  ['requirePermission', () => requirePermission('invoicing', 'sales-invoices', 'WRITE')],
  ['requireModuleAccess', () => requireModuleAccess('invoicing')],
])('%s and the audit "before" snapshot', (_name, makeGate) => {
  it('takes the snapshot once the request is allowed, before the handler runs', async () => {
    const res = makeRes();
    await makeGate()(req, res, () => { state.order.push('next'); });
    expect(state.order).toEqual(['snapshot', 'next']);
    expect(res.statusCode).toBe(200);
  });

  it('does not read anything for a request that is rejected with 403', async () => {
    state.allowed = false;
    const res = makeRes();
    await makeGate()(req, res, () => { state.order.push('next'); });
    expect(captureBeforeSnapshot).not.toHaveBeenCalled();
    expect(state.order).toEqual([]);
    expect(res.statusCode).toBe(403);
  });
});

describe('captureAuditBefore (for routers without a permission gate)', () => {
  it('takes the snapshot and then continues', async () => {
    await captureAuditBefore(req, makeRes(), () => { state.order.push('next'); });
    expect(state.order).toEqual(['snapshot', 'next']);
  });
});
