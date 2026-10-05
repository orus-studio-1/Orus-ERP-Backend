import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import type { AuthRequest } from './auth';
import { error } from '../utils/response';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const sensitiveKeys = new Set(['password', 'currentPassword', 'newPassword', 'token', 'accessToken', 'refreshToken', 'authorization', 'credentialsEncrypted', 'uploadUrl', 'downloadUrl', 'signedUrl', 'presignedUrl']);
// Any key that looks like a secret, hash, key material or one-time code is redacted from audit JSON.
const sensitiveKeyPattern = /password|passwd|secret|token|credential|hash|api[-_]?key|private[-_]?key|storage[-_]?key|otp|recovery/i;
// Personal / financial identifiers are redacted too (matched on the exact column name so that e.g.
// "company" or "panAvailable" are untouched).
const sensitiveExactKeyPattern = /^(pan|taxId|bankAccount|accountNumber|ifsc|iban|aadhaar|aadhar|ssn|cvv|cardNumber)$/i;
// Models whose rows are credentials/sessions are never snapshotted into an audit row at all: the
// explicit names below plus anything whose model name looks like a session/token/key/secret store.
const snapshotDenylist = new Set(['webhookSubscription', 'crmIntegrationAccount']);
const credentialModelPattern = /session|token|apikey|credential|secret|recovery/i;
const isSnapshotDenied = (delegate: string) => snapshotDenylist.has(delegate) || credentialModelPattern.test(delegate);
const warnedUnresolved = new Set<string>();
const auditDelegates: Record<string, string> = {
  'accounting:accounts': 'account', 'crm:leads': 'lead', 'crm:organizations': 'organization', 'crm:contacts': 'contact', 'crm:opportunities': 'opportunity', 'crm:activities': 'activity',
  'customers:request': 'customer', 'suppliers:request': 'supplier', 'projects:request': 'project',
  'inventory:products': 'product', 'inventory:categories': 'category', 'inventory:warehouses': 'warehouse', 'inventory:units': 'unit', 'inventory:stock-entries': 'stockEntry',
  'sales:quotations': 'quotation', 'sales:orders': 'salesOrder', 'sales:sales-orders': 'salesOrder', 'sales:enquiries': 'salesEnquiry',
  'invoices:request': 'salesInvoice', 'invoicing:sales-invoices': 'salesInvoice', 'delivery-notes:request': 'deliveryNote',
  'hr:employees': 'employee', 'hr:departments': 'department', 'hr:positions': 'position',
  'procurement:material-requests': 'materialRequest', 'procurement:rfqs': 'requestForQuotation', 'procurement:purchase-orders': 'purchaseOrder', 'procurement:purchase-receipts': 'purchaseReceipt', 'procurement:purchase-invoices': 'purchaseInvoice',
  // Resources whose Prisma model name does not follow from the route name.
  'access:roles': 'accessRole', 'accounting:recurring-journals': 'recurringJournalEntry',
  'crm:assignment-rules': 'crmAssignmentRule', 'crm:saved-views': 'crmSavedView', 'crm:scope-rules': 'crmScopeRule', 'crm:lost-reasons': 'crmLostReason', 'crm:email-templates': 'crmEmailTemplate', 'crm:communications': 'crmCommunication', 'crm:integrations': 'crmIntegrationAccount', 'crm:capture-tokens': 'crmCaptureToken',
  'hr:lifecycle-events': 'employeeLifecycleEvent',
  'inventory:reconciliations': 'stockReconciliation', 'inventory:attributes': 'productAttribute', 'inventory:uom-conversions': 'productUomConversion', 'inventory:transfer-orders': 'stockTransferOrder',
  'invoicing:invoices': 'salesInvoice', 'invoicing:subscriptions': 'subscriptionTemplate', 'payments:entries': 'paymentEntry',
  'manufacturing:work-orders': 'manufacturingWorkOrder', 'sales:production-plans': 'salesProductionPlan',
  'procurement:three-way-matches': 'procurementThreeWayMatch', 'procurement:vendor-ratings': 'vendorRatingHistory', 'procurement:communications': 'supplierCommunicationLog',
};

// POST /module/resource/:id/<operation> acts on an existing record, so it also gets a "before" snapshot.
export const documentOperations = new Set(['submit', 'cancel', 'amend', 'approve', 'reject', 'convert', 'complete', 'dispatch', 'receive', 'post', 'close', 'reopen', 'revise', 'status', 'win', 'lose', 'qualify', 'assign', 'merge', 'stage', 'mark-lost', 'send', 'confirm', 'accept', 'release', 'start', 'pause', 'resume', 'finish', 'issue', 'reverse', 'return']);

// "journal-entries" -> "journalEntry", "leave-requests" -> "leaveRequest"
function singularCamel(resource: string) {
  const parts = resource.split('-');
  const last = parts.pop() || '';
  const singular = last.endsWith('ies') ? `${last.slice(0, -3)}y` : /(ch|sh|x|z|ss)es$/.test(last) ? last.slice(0, -2) : last.endsWith('s') && !last.endsWith('ss') ? last.slice(0, -1) : last;
  return [...parts, singular].map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join('');
}

// Explicit entries in auditDelegates win; every other resource is resolved from its route name when
// a Prisma model of that name exists, so new modules get "before" snapshots without being listed.
const resolvedDelegates = new Map<string, string | null>();
export function auditDelegateFor(moduleName: string, resource: string): string | undefined {
  const key = `${moduleName}:${resource}`;
  if (auditDelegates[key]) return auditDelegates[key];
  if (!resolvedDelegates.has(key)) {
    const candidate = resource === 'request' ? '' : singularCamel(resource);
    resolvedDelegates.set(key, candidate && typeof (prisma as any)[candidate]?.findUnique === 'function' ? candidate : null);
  }
  return resolvedDelegates.get(key) || undefined;
}

function parseAuditPath(rawPath: string, method: string) {
  const pathParts = rawPath.split('?')[0].split('/').filter(Boolean);
  if (pathParts[0] === 'api') pathParts.shift();
  if (pathParts[0] === 'v1') pathParts.shift();
  const moduleName = pathParts[0] || 'system';
  const rootResource = ['customers', 'suppliers', 'projects', 'invoices', 'delivery-notes'].includes(moduleName);
  const resource = rootResource ? 'request' : pathParts[1] || 'request';
  const candidateId = pathParts[rootResource ? 1 : 2];
  const operation = pathParts[rootResource ? 2 : 3]?.toLowerCase();
  const pathEntityId = ['PUT', 'PATCH', 'DELETE'].includes(method) || (method === 'POST' && operation && documentOperations.has(operation)) ? candidateId : undefined;
  return { moduleName, resource, pathEntityId };
}

// Called by authenticate() once the user is verified and the tenant context is active, so the
// "before" read only happens for real, authorised sessions and is scoped to their tenant/company
// (the tenant extension scopes findFirst, not findUnique). The row is stored on req.auditBefore
// and picked up by mutationAudit when the response is sent.
export async function captureBeforeSnapshot(req: AuthRequest) {
  const flags = req as any;
  if (flags.auditBeforeDone || !mutationMethods.has(req.method)) return;
  flags.auditBeforeDone = true;
  const { moduleName, resource, pathEntityId } = parseAuditPath(req.originalUrl, req.method);
  if (!pathEntityId || moduleName === 'auth') return;
  const delegateName = auditDelegateFor(moduleName, resource);
  if (!delegateName) {
    if (!warnedUnresolved.has(`${moduleName}:${resource}`)) {
      warnedUnresolved.add(`${moduleName}:${resource}`);
      console.warn(`[audit] no Prisma model resolved for ${moduleName}:${resource}; "before" snapshots are skipped for it (add it to auditDelegates if it is a record).`);
    }
    return;
  }
  if (isSnapshotDenied(delegateName) || !(prisma as any)[delegateName]?.findFirst) return;
  try { flags.auditBefore = await (prisma as any)[delegateName].findFirst({ where: { id: pathEntityId } }); }
  catch { flags.auditBefore = undefined; }
}

const NUL = /\u0000/g;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value: unknown, max: number): string | undefined {
  if (value == null) return undefined;
  const text = String(value).replace(NUL, '');
  return text.length > max ? text.slice(0, max) : text;
}

// tenantId and branchId are uuid columns: anything else would make the insert fail.
function cleanUuid(value: unknown, field: string): string | undefined {
  if (value == null || value === '') return undefined;
  const text = String(value);
  if (UUID_PATTERN.test(text)) return text;
  console.warn(`[audit] ignoring ${field} that is not a uuid: ${text.slice(0, 60)}`);
  return undefined;
}

// Last step before a row reaches the database. The audit insert can now run inside a business
// transaction, so a malformed value must never be able to make it fail (and abort the business
// change): every column is coerced to something Postgres is guaranteed to accept.
function toSafeAuditRow(row: Record<string, any>) {
  return {
    ...row,
    tenantId: cleanUuid(row.tenantId, 'tenantId'),
    branchId: cleanUuid(row.branchId, 'branchId'),
    companyId: cleanText(row.companyId, 200),
    userId: cleanText(row.userId, 200),
    entityType: cleanText(row.entityType, 200) || 'UNKNOWN',
    entityId: cleanText(row.entityId, 200),
    action: cleanText(row.action, 100) || 'UNKNOWN',
    statusBefore: cleanText(row.statusBefore, 100),
    statusAfter: cleanText(row.statusAfter, 100),
    message: cleanText(row.message, 2000),
    targetUserId: cleanText(row.targetUserId, 200),
    targetRoleId: cleanText(row.targetRoleId, 200),
    rfqId: cleanText(row.rfqId, 200),
    ip: cleanText(row.ip, 100),
    userAgent: cleanText(row.userAgent, 500),
    requestId: cleanText(row.requestId, 200),
  };
}

function sanitizeAuditValue(value: any, depth = 0): any {
  if (value == null || typeof value === 'boolean') return value;
  // NaN / Infinity are not valid JSON numbers, so they are stored as text instead.
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  // Postgres rejects the NUL character in both text and JSON, so it is removed from every string.
  if (typeof value === 'string') { const text = value.replace(NUL, ''); return text.length > 1000 ? `${text.slice(0, 1000)}…` : text; }
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toJSON === 'function') return sanitizeAuditValue(value.toJSON(), depth);
  if (depth >= 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeAuditValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key.replace(NUL, ''), sensitiveKeys.has(key) || sensitiveKeyPattern.test(key) || sensitiveExactKeyPattern.test(key) ? '[REDACTED]' : sanitizeAuditValue(item, depth + 1)]));
  return String(value);
}

function auditAction(req: Request) {
  const segments = req.path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1]?.toLowerCase();
  if (req.method === 'POST' && lastSegment && documentOperations.has(lastSegment)) return lastSegment.toUpperCase().replace(/-/g, '_');
  return req.method === 'POST' ? 'CREATE' : req.method === 'DELETE' ? 'DELETE' : 'UPDATE';
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

export async function idempotency(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.method !== 'POST' || req.path.startsWith('/auth/')) return next();
  const key = String(req.headers['idempotency-key'] || '');
  if (!key) return error(res, 'Idempotency-Key header is required', 400, [{ field: 'Idempotency-Key', message: 'Required for document and money POST requests' }], 'IDEMPOTENCY_KEY_REQUIRED');
  const tenantId = req.user?.tenantId;
  if (!tenantId) return error(res, 'Tenant context is required', 403, undefined, 'TENANT_REQUIRED');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ method: req.method, path: req.originalUrl, body: req.body })).digest('hex');
  const existing = await prisma.idempotencyRecord.findUnique({ where: { tenantId_key: { tenantId, key } } });
  if (existing) {
    if (existing.requestHash !== requestHash) return error(res, 'Idempotency key was used with a different request', 409, undefined, 'IDEMPOTENCY_CONFLICT');
    if (existing.state === 'COMPLETED') {
      // Replaying a stored response did not change anything, so it must not be audited again.
      res.locals.skipAudit = true;
      return res.status(200).json(existing.responseBody);
    }
    return error(res, 'An identical request is already processing', 409, undefined, 'IDEMPOTENCY_IN_PROGRESS');
  }
  await prisma.idempotencyRecord.create({ data: { tenantId, key, requestHash, method: req.method, path: req.originalUrl, expiresAt: new Date(Date.now() + 86400000) } });
  const originalJson = res.json.bind(res);
  res.json = ((body: any) => {
    const completed = res.statusCode < 500;
    prisma.idempotencyRecord.update({ where: { tenantId_key: { tenantId, key } }, data: { state: completed ? 'COMPLETED' : 'FAILED', statusCode: res.statusCode, responseBody: body, completedAt: new Date() } }).catch(() => null);
    return originalJson(body);
  }) as any;
  next();
}

export function optimisticConcurrency(req: Request, res: Response, next: NextFunction) {
  if (!['PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const value = req.headers['if-match'] ?? req.body?.version;
  if (value == null) return error(res, 'If-Match header or version field is required', 428, [{ field: 'version', message: 'Required for mutable resources' }], 'VERSION_REQUIRED');
  const parsed = Number(String(value).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(parsed) || parsed < 1) return error(res, 'Version must be a positive integer', 400, undefined, 'VERSION_INVALID');
  (req as any).expectedVersion = parsed;
  next();
}

// Queues a rich audit event (entityType/entityId/action/before/after/diff/message/statusBefore/
// statusAfter/targetUserId/targetRoleId/rfqId/companyId/tenantId/userId) for mutationAudit below
// to write when the response is sent. A request can touch more than one entity, so this queues
// instead of overwriting -- each call adds one row. Business code must never write an audit row
// directly; this is the only way to record one.
export function setAuditContext(req: Request, patch: Record<string, any>) {
  const events: Record<string, any>[] = (req as any).auditEvents || ((req as any).auditEvents = []);
  events.push(patch);
}

// Builds one audit row from an explicit event plus whatever the request itself knows. Everything
// the event does not state is derived from the route, the signed-in user and the request.
function buildAuditRow(req: AuthRequest, context: Record<string, any>, responseData?: any) {
  const { moduleName, resource, pathEntityId } = parseAuditPath(req.originalUrl || req.path, req.method);
  const entityId = context.entityId || req.params?.id || pathEntityId || responseData?.id || responseData?.data?.id;
  // The request carries one "before" snapshot (the record in the URL) and one response body. They
  // describe a single record, so an event that explicitly names a different entity must not inherit
  // them (e.g. amending an invoice also logs the new draft, which has no "before" of its own).
  const explicitEntity = Boolean(context.entityId);
  const snapshot = (req as any).auditBefore;
  const responseId = responseData?.id ?? responseData?.data?.id;
  const snapshotBelongsHere = snapshot !== undefined && (!explicitEntity || String(snapshot?.id) === String(context.entityId));
  const responseBelongsHere = responseData !== undefined && (!explicitEntity || (responseId != null && String(responseId) === String(context.entityId)));
  return toSafeAuditRow({
    tenantId: context.tenantId ?? req.user?.tenantId ?? undefined,
    companyId: context.companyId ?? req.user?.companyId,
    branchId: context.branchId ?? req.user?.branchId ?? undefined,
    userId: context.userId ?? req.user?.id,
    entityType: context.entityType ? String(context.entityType) : `${moduleName}:${resource}`.toUpperCase(),
    entityId: entityId ? String(entityId) : undefined,
    action: context.action || auditAction(req),
    statusBefore: context.statusBefore,
    statusAfter: context.statusAfter,
    message: context.message,
    targetUserId: context.targetUserId,
    targetRoleId: context.targetRoleId,
    rfqId: context.rfqId,
    before: context.before !== undefined ? sanitizeAuditValue(context.before) : snapshotBelongsHere ? sanitizeAuditValue(snapshot) : undefined,
    diff: context.diff !== undefined ? sanitizeAuditValue(context.diff) : sanitizeAuditValue(req.body || {}),
    after: context.after !== undefined ? sanitizeAuditValue(context.after) : responseBelongsHere ? sanitizeAuditValue(responseData) : undefined,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.context?.requestId,
  });
}

// Records an audit event inside the caller's database transaction, so the audit row and the business
// change commit or roll back together (an audit failure aborts the change instead of being lost).
// Use this where a transaction already exists; setAuditContext covers everything else. It is still
// the only place that writes an audit row, and it tells mutationAudit not to add an automatic row for
// the same request. The response is not known yet, so `after` is only stored if the event gives it.
// It refuses anything that is not a transaction client: falling back to the global client would
// silently make the write non-atomic, which is exactly what this function exists to prevent.
export async function recordAuditEvent(tx: any, req: Request, event: Record<string, any>) {
  // Only the root client exposes $connect; an interactive transaction client does not.
  if (!tx || typeof tx.platformAuditLog?.create !== 'function' || typeof tx.$connect === 'function') {
    throw new Error('recordAuditEvent must be called with a transaction client (prisma.$transaction(async (tx) => ...)); use setAuditContext when there is no transaction');
  }
  const row = buildAuditRow(req as AuthRequest, event);
  await tx.platformAuditLog.create({ data: { id: crypto.randomUUID(), ...row } });
  (req as any).auditPersisted = true;
}

export async function mutationAudit(req: AuthRequest, res: Response, next: NextFunction) {
  if (!mutationMethods.has(req.method)) return next();
  const { moduleName } = parseAuditPath(req.path, req.method);
  const originalJson = res.json.bind(res);
  res.json = ((body: any) => {
    const events: Record<string, any>[] = (req as any).auditEvents || [];
    const hasAuditIntent = (Boolean(req.user) || events.length > 0) && !res.locals?.skipAudit;
    if (hasAuditIntent && res.statusCode >= 200 && res.statusCode < 400 && moduleName !== 'auth') {
      const responseData = body?.data;
      // Rows to write now: every queued event; with none queued, the single automatic row derived
      // from the route, unless a transaction already persisted the rich event for this request.
      const sources = events.length ? events : (req as any).auditPersisted ? [] : [{}];
      const rows = sources.map((context) => buildAuditRow(req, context, responseData));
      if (!rows.length) return originalJson(body);
      // The response is held until the audit rows are stored, so a failed write is never silent: it is
      // retried once, and if it still fails the rows are logged for recovery and the client is warned
      // with an X-Audit-Warning header (the business change itself is already committed by now).
      // This runs after the controller has returned, so an error thrown while sending (an
      // unserialisable body, headers already sent) can no longer reach the controller's own catch.
      // Answer with a generic 500 instead of leaving the request open forever.
      const sendResponse = () => {
        try { originalJson(body); }
        catch (err) {
          console.error('Unable to send response after the audit write:', err);
          if (res.headersSent) { res.end(); return; }
          try { res.status(500); originalJson({ success: false, message: 'Internal server error' }); }
          catch { res.end(); }
        }
      };
      void writeAuditRows(rows).catch(() => false).then((stored) => {
        if (!stored && !res.headersSent) res.setHeader('X-Audit-Warning', 'write-failed');
        sendResponse();
      });
      return res;
    }
    return originalJson(body);
  }) as any;
  next();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`audit write timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

// Each attempt is bounded by AUDIT_WRITE_TIMEOUT_MS so a stalled database cannot hang every mutation
// response. Rows get their ids up front and are inserted with skipDuplicates, so retrying after a
// timeout (where the first insert may still complete) can never store the same event twice.
async function writeAuditRows(rows: Record<string, any>[]) {
  const timeoutMs = Number(process.env.AUDIT_WRITE_TIMEOUT_MS) || 4000;
  const data = rows.map((row) => ({ id: crypto.randomUUID(), ...row }));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await withTimeout(prisma.platformAuditLog.createMany({ data: data as any, skipDuplicates: true }), timeoutMs); return true; }
    catch (err) { if (attempt === 2) console.error('AUDIT WRITE FAILED - rows for manual recovery:', err, JSON.stringify(data)); }
  }
  return false;
}
