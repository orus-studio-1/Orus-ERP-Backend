import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  rows: [] as any[],
  lookups: [] as any[],
  createMany: vi.fn(),
  idempotencyRecord: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({
  default: {
    platformAuditLog: { createMany: store.createMany },
    idempotencyRecord: store.idempotencyRecord,
    leaveType: { findUnique: vi.fn(), findFirst: vi.fn(async ({ where }: any) => { store.lookups.push(where.id); return { id: where.id, name: 'OLD', parentHash: 'h', pan: 'ABCDE1234F', panAvailable: true, company: 'Acme' }; }) },
    journalEntry: { findUnique: vi.fn(), findFirst: vi.fn() },
    batch: { findUnique: vi.fn(), findFirst: vi.fn() },
    apiKey: { findUnique: vi.fn(), findFirst: vi.fn(async () => { store.lookups.push('apiKey'); return { id: 'k' }; }) },
  },
}));

import { auditDelegateFor, captureBeforeSnapshot, idempotency, mutationAudit, recordAuditEvent, setAuditContext } from './platform';


async function run(method: string, path: string, options: { headers?: any; user?: any; queue?: (req: any) => void | Promise<void>; locals?: any; before?: any } = {}) {
  const headers: Record<string, string> = {};
  const req: any = { method, path, params: {}, body: { x: 1 }, headers: options.headers || {}, ip: '1.1.1.1', get: () => 'ua', user: options.user };
  let sent = false;
  const res: any = { statusCode: 200, headersSent: false, locals: options.locals || {}, setHeader: (key: string, value: string) => { headers[key] = value; }, json(body: any) { sent = true; return body; } };
  await new Promise<void>((resolve) => mutationAudit(req, res, () => resolve()));
  if (options.before) req.auditBefore = options.before;
  await options.queue?.(req);
  const returned = res.json({ data: { id: 'resp1' } });
  const sentImmediately = sent;
  await vi.waitFor(() => expect(sent).toBe(true));
  return { rows: store.rows, headers, sentImmediately, returned, res };
}

const T1 = '0198aaaa-0000-7000-8000-000000000001';
const T9 = '0198aaaa-0000-7000-8000-000000000009';
const user = { id: 'u1', tenantId: T1, companyId: 'c1' };

beforeEach(() => {
  store.rows = [];
  store.lookups = [];
  store.createMany.mockReset();
  store.createMany.mockImplementation(async ({ data }: any) => { store.rows.push(...data); return {}; });
});

describe('mutationAudit queueing', () => {
  it('writes one automatic row derived from the route when nothing is queued', async () => {
    const { rows } = await run('POST', '/api/v1/hr/leave-types', { user });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'HR:LEAVE-TYPES', action: 'CREATE', entityId: 'resp1', tenantId: T1, companyId: 'c1', userId: 'u1' });
  });

  it('writes one row per queued event, so one request can audit several entities', async () => {
    const { rows } = await run('POST', '/api/v1/sales/quotations/q1/accept', {
      user,
      queue: (req) => {
        setAuditContext(req, { entityType: 'QUOTATION', entityId: 'q1', action: 'ACCEPT', statusBefore: 'SENT', statusAfter: 'ACCEPTED' });
        setAuditContext(req, { entityType: 'SALES_ORDER', entityId: 's1', action: 'CREATE', message: 'auto', rfqId: 'r1', targetUserId: 'u2' });
      },
    });
    expect(rows.map((row) => [row.entityType, row.entityId, row.action])).toEqual([['QUOTATION', 'q1', 'ACCEPT'], ['SALES_ORDER', 's1', 'CREATE']]);
    expect(rows[0]).toMatchObject({ statusBefore: 'SENT', statusAfter: 'ACCEPTED' });
    expect(rows[1]).toMatchObject({ message: 'auto', rfqId: 'r1', targetUserId: 'u2' });
  });

  it('audits an unauthenticated route when it queued an event with explicit tenant and company', async () => {
    const { rows } = await run('POST', '/api/v1/procurement/rfqs/vendor/tok/acknowledge', {
      queue: (req) => setAuditContext(req, { entityType: 'RFQ', entityId: 'r1', action: 'VENDOR_ACK', companyId: 'c9', tenantId: T9 }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: 'c9', tenantId: T9, userId: undefined });
  });

  it('writes nothing for an unauthenticated request that queued no event', async () => {
    const { rows } = await run('POST', '/api/v1/hr/leave-types');
    expect(rows).toHaveLength(0);
  });

  it('names POST record operations after the operation instead of CREATE', async () => {
    const { rows } = await run('POST', '/api/v1/crm/opportunities/opp1/win', { user });
    expect(rows[0]).toMatchObject({ action: 'WIN', entityId: 'opp1' });
    const sent = await run('POST', '/api/v1/procurement/rfqs/r1/send', { user });
    expect(sent.rows[sent.rows.length - 1]).toMatchObject({ action: 'SEND', entityId: 'r1' });
  });
});

describe('before snapshots', () => {
  const snapshotReq = (method: string, originalUrl: string) => ({ method, originalUrl, headers: {} }) as any;

  it('reads the record only for record-level mutations and stores it on the request', async () => {
    const req = snapshotReq('PUT', '/api/v1/hr/leave-types/abc?x=1');
    await captureBeforeSnapshot(req);
    expect(store.lookups).toEqual(['abc']);
    expect(req.auditBefore).toMatchObject({ id: 'abc', name: 'OLD' });

    store.lookups = [];
    await captureBeforeSnapshot(snapshotReq('POST', '/api/v1/hr/leave-types'));
    await captureBeforeSnapshot(snapshotReq('GET', '/api/v1/hr/leave-types/abc'));
    expect(store.lookups).toEqual([]);
  });

  it('snapshots only once per request even when authenticate runs twice', async () => {
    const req = snapshotReq('DELETE', '/api/v1/hr/leave-types/abc');
    await captureBeforeSnapshot(req);
    await captureBeforeSnapshot(req);
    expect(store.lookups).toEqual(['abc']);
  });

  it('never snapshots credential-style models', async () => {
    await captureBeforeSnapshot(snapshotReq('DELETE', '/api/v1/platform/api-keys/k1'));
    expect(store.lookups).not.toContain('apiKey');
  });

  it('writes the captured snapshot into the audit row and redacts sensitive and personal fields', async () => {
    const { rows } = await run('PUT', '/api/v1/hr/leave-types/abc', { user, before: { id: 'abc', name: 'OLD', parentHash: 'h', pan: 'ABCDE1234F', panAvailable: true, company: 'Acme' } });
    expect(rows[0].before).toMatchObject({ id: 'abc', name: 'OLD', parentHash: '[REDACTED]', pan: '[REDACTED]', panAvailable: true, company: 'Acme' });
  });

  it('gives the snapshot and response only to the event for that record, not to other entities in the request', async () => {
    const { rows } = await run('POST', '/api/v1/invoices/inv1/amend', {
      user,
      before: { id: 'inv1', invoiceNo: 'INV-1' },
      queue: (req) => {
        setAuditContext(req, { entityType: 'SALES_INVOICE', entityId: 'new1', action: 'AMEND' });
        setAuditContext(req, { entityType: 'SALES_INVOICE', entityId: 'inv1', action: 'AMEND' });
        setAuditContext(req, { entityType: 'SALES_INVOICE', entityId: 'resp1', action: 'AMEND' });
      },
    });
    const byEntity = Object.fromEntries(rows.map((row) => [row.entityId, row]));
    expect(byEntity.new1.before).toBeUndefined();
    expect(byEntity.new1.after).toBeUndefined();
    expect(byEntity.inv1.before).toMatchObject({ id: 'inv1', invoiceNo: 'INV-1' });
    expect(byEntity.inv1.after).toBeUndefined();
    expect(byEntity.resp1.before).toBeUndefined();
    expect(byEntity.resp1.after).toMatchObject({ id: 'resp1' });
  });

  it('still gives the snapshot and response to the automatic row, which describes the request\x27s own record', async () => {
    const { rows } = await run('PUT', '/api/v1/hr/leave-types/abc', { user, before: { id: 'abc', name: 'OLD' } });
    expect(rows[0].before).toMatchObject({ id: 'abc', name: 'OLD' });
    expect(rows[0].after).toMatchObject({ id: 'resp1' });
  });

  it('resolves models from route names and keeps explicit overrides', () => {
    expect(auditDelegateFor('accounting', 'journal-entries')).toBe('journalEntry');
    expect(auditDelegateFor('inventory', 'batches')).toBe('batch');
    expect(auditDelegateFor('crm', 'leads')).toBe('lead');
    expect(auditDelegateFor('hr', 'not-a-model')).toBeUndefined();
  });
});

describe('audit write durability', () => {
  it('gives up on a stalled database after the timeout, still answers, and warns', async () => {
    process.env.AUDIT_WRITE_TIMEOUT_MS = '40';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.createMany.mockImplementation(() => new Promise(() => undefined));
    const { headers } = await run('POST', '/api/v1/hr/leave-types', { user });
    expect(store.createMany).toHaveBeenCalledTimes(2);
    expect(headers['X-Audit-Warning']).toBe('write-failed');
    log.mockRestore();
    delete process.env.AUDIT_WRITE_TIMEOUT_MS;
  });

  it('sends the same ids and skipDuplicates on a retry so a late first insert cannot duplicate rows', async () => {
    store.createMany.mockRejectedValueOnce(new Error('db down'));
    await run('POST', '/api/v1/hr/leave-types', { user });
    const [first, second] = store.createMany.mock.calls.map((call: any[]) => call[0]);
    expect(first.skipDuplicates).toBe(true);
    expect(first.data[0].id).toBeTruthy();
    expect(second.data[0].id).toBe(first.data[0].id);
  });

  it('holds the response until the audit rows are stored', async () => {
    store.createMany.mockImplementation(async ({ data }: any) => { await new Promise((resolve) => setTimeout(resolve, 30)); store.rows.push(...data); return {}; });
    const { sentImmediately, rows } = await run('POST', '/api/v1/hr/leave-types', { user });
    expect(sentImmediately).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it('retries once and sends no warning when the second attempt succeeds', async () => {
    store.createMany.mockRejectedValueOnce(new Error('db down'));
    const { rows, headers } = await run('POST', '/api/v1/hr/leave-types', { user });
    expect(store.createMany).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(headers['X-Audit-Warning']).toBeUndefined();
  });

  it('still answers the client but warns when the audit write keeps failing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.createMany.mockRejectedValue(new Error('db down'));
    const { rows, headers } = await run('POST', '/api/v1/hr/leave-types', { user });
    expect(rows).toHaveLength(0);
    expect(headers['X-Audit-Warning']).toBe('write-failed');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('deferred response when sending fails', () => {
  const setup = (throwOnFirstSend: boolean, headersAlreadySent = false) => {
    const sent: any[] = [];
    let calls = 0;
    const req: any = { method: 'POST', path: '/api/v1/hr/leave-types', originalUrl: '/api/v1/hr/leave-types', params: {}, body: {}, headers: {}, ip: '1.1.1.1', get: () => 'ua', user };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      setHeader: () => undefined,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { calls++; if (throwOnFirstSend && calls === 1) { this.headersSent = headersAlreadySent; throw new TypeError('Do not know how to serialize a BigInt'); } sent.push({ code: this.statusCode, body }); return this; },
      end() { sent.push('end'); },
    };
    return { req, res, sent };
  };

  it('answers with a generic 500 instead of leaving the request open', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { req, res, sent } = setup(true);
    await new Promise<void>((resolve) => mutationAudit(req, res, () => resolve()));
    res.json({ data: { id: 'x' } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ code: 500, body: { success: false, message: 'Internal server error' } });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('ends the response when the headers were already sent', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { req, res, sent } = setup(true, true);
    await new Promise<void>((resolve) => mutationAudit(req, res, () => resolve()));
    res.json({ data: { id: 'x' } });
    await vi.waitFor(() => expect(sent).toEqual(['end']));
    log.mockRestore();
  });

  it('sends normally when nothing fails', async () => {
    const { req, res, sent } = setup(false);
    await new Promise<void>((resolve) => mutationAudit(req, res, () => resolve()));
    res.json({ data: { id: 'x' } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ code: 200, body: { data: { id: 'x' } } });
  });
});

describe('idempotency replay', () => {
  it('does not audit a replayed stored response', async () => {
    const body = { data: { id: 'x' } };
    store.idempotencyRecord.findUnique.mockResolvedValue({ requestHash: 'h', state: 'COMPLETED', responseBody: body });
    const hash = (await import('crypto')).createHash('sha256').update(JSON.stringify({ method: 'POST', path: '/api/v1/platform/documents', body: { a: 1 } })).digest('hex');
    store.idempotencyRecord.findUnique.mockResolvedValue({ requestHash: hash, state: 'COMPLETED', responseBody: body });

    const req: any = { method: 'POST', path: '/documents', originalUrl: '/api/v1/platform/documents', body: { a: 1 }, headers: { 'idempotency-key': 'k1' }, ip: '1.1.1.1', get: () => 'ua', user };
    let sent = false;
    const res: any = { statusCode: 200, headersSent: false, locals: {}, setHeader: () => undefined, status(code: number) { this.statusCode = code; return this; }, json() { sent = true; return this; } };
    await new Promise<void>((resolve) => mutationAudit(req, res, () => resolve()));
    await idempotency(req, res, () => undefined);
    await vi.waitFor(() => expect(sent).toBe(true));
    expect(store.createMany).not.toHaveBeenCalled();
  });
});

describe('recordAuditEvent (inside the caller transaction)', () => {
  const makeTx = () => ({ platformAuditLog: { create: vi.fn(async ({ data }: any) => data) } });

  it('writes the row through the given transaction and suppresses the automatic row', async () => {
    const tx = makeTx();
    const { rows } = await run('POST', '/api/v1/invoices/inv1/submit', {
      user,
      before: { id: 'inv1', status: 'DRAFT' },
      queue: (req) => recordAuditEvent(tx, req, { entityType: 'SALES_INVOICE', entityId: 'inv1', action: 'SUBMIT', statusBefore: 'DRAFT', statusAfter: 'SUBMITTED', message: 'Submitted INV-1' }),
    });
    expect(tx.platformAuditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.platformAuditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ entityType: 'SALES_INVOICE', entityId: 'inv1', action: 'SUBMIT', statusBefore: 'DRAFT', statusAfter: 'SUBMITTED', tenantId: T1, companyId: 'c1', userId: 'u1', before: { id: 'inv1', status: 'DRAFT' } });
    expect(data.id).toBeTruthy();
    expect(store.createMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('still writes events that were queued after the response for the same request', async () => {
    const tx = makeTx();
    const { rows } = await run('POST', '/api/v1/sales/quotations/q1/accept', {
      user,
      queue: async (req) => {
        await recordAuditEvent(tx, req, { entityType: 'QUOTATION', entityId: 'q1', action: 'ACCEPT' });
        setAuditContext(req, { entityType: 'SALES_ORDER', entityId: 's1', action: 'CREATE' });
      },
    });
    expect(tx.platformAuditLog.create).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.entityType)).toEqual(['SALES_ORDER']);
  });

  it('refuses to run without a transaction client instead of silently writing outside one', async () => {
    const req: any = { method: 'POST', originalUrl: '/api/v1/invoices/inv1/submit', params: {}, body: {}, headers: {}, user, get: () => 'ua' };
    const event = { entityType: 'SALES_INVOICE', entityId: 'inv1', action: 'SUBMIT' };
    await expect(recordAuditEvent(undefined, req, event)).rejects.toThrow(/transaction client/);
    await expect(recordAuditEvent(null, req, event)).rejects.toThrow(/transaction client/);
    const rootClient = { $connect: () => undefined, platformAuditLog: { create: vi.fn() } };
    await expect(recordAuditEvent(rootClient, req, event)).rejects.toThrow(/transaction client/);
    expect(rootClient.platformAuditLog.create).not.toHaveBeenCalled();
    expect(req.auditPersisted).toBeUndefined();
  });

  it('lets a failing audit insert reject so the surrounding transaction rolls back', async () => {
    const tx = { platformAuditLog: { create: vi.fn(async () => { throw new Error('insert failed'); }) } };
    const req: any = { method: 'POST', originalUrl: '/api/v1/invoices/inv1/submit', params: {}, body: {}, headers: {}, user, get: () => 'ua' };
    await expect(recordAuditEvent(tx, req, { entityType: 'SALES_INVOICE', entityId: 'inv1', action: 'SUBMIT' })).rejects.toThrow('insert failed');
    expect(req.auditPersisted).toBeUndefined();
  });
});

describe('audit row safety (a malformed value must never make the insert fail)', () => {
  const nasty = {
    tenantId: 'not-a-uuid',
    branchId: 'also bad',
    entityType: '',
    entityId: 'id-with-nul- -char',
    action: undefined,
    message: 'm'.repeat(5000),
    statusBefore: 'DRAFT ',
    before: { 'bad key': 'v alue', nan: Number.NaN, inf: Number.POSITIVE_INFINITY, ok: 3 },
    after: { nested: { text: 'x y' } },
  };

  it('coerces every column to a value Postgres accepts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rows } = await run('POST', '/api/v1/hr/leave-types', { user, queue: (req) => setAuditContext(req, nasty) });
    const row = rows[0];
    expect(row.tenantId).toBeUndefined();
    expect(row.branchId).toBeUndefined();
    expect(row.entityType).toBe('HR:LEAVE-TYPES');
    expect(row.action).toBe('CREATE');
    expect(row.entityId).toBe('id-with-nul--char');
    expect(row.message).toHaveLength(2000);
    expect(row.statusBefore).toBe('DRAFT');
    expect(row.before).toEqual({ badkey: 'value', nan: 'NaN', inf: 'Infinity', ok: 3 });
    expect(row.after).toEqual({ nested: { text: 'xy' } });
    expect(JSON.stringify(row)).not.toContain('\u0000');
    warn.mockRestore();
  });

  it('keeps valid uuids and caps oversized user agents', async () => {
    const tenantId = '0198aaaa-0000-7000-8000-000000000001';
    const req: any = { method: 'POST', originalUrl: '/api/v1/hr/leave-types', params: {}, body: {}, headers: {}, user: { id: 'u1', tenantId, companyId: 'c1' }, get: () => 'u'.repeat(2000) };
    const tx = { platformAuditLog: { create: vi.fn(async ({ data }: any) => data) } };
    await recordAuditEvent(tx, req, { entityType: 'LEAVE_TYPE', entityId: 'x', action: 'CREATE' });
    const data = tx.platformAuditLog.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(tenantId);
    expect(data.userAgent).toHaveLength(500);
  });
});
