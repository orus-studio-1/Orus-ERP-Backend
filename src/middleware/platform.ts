import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { AuthRequest } from './auth';
import { error } from '../utils/response';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const sensitiveKeys = new Set(['password', 'currentPassword', 'newPassword', 'token', 'accessToken', 'refreshToken', 'authorization', 'credentialsEncrypted', 'uploadUrl', 'downloadUrl', 'signedUrl', 'presignedUrl']);
const auditDelegates: Record<string, string> = {
  'accounting:accounts': 'account', 'crm:leads': 'lead', 'crm:organizations': 'organization', 'crm:contacts': 'contact', 'crm:opportunities': 'opportunity', 'crm:activities': 'activity',
  'customers:request': 'customer', 'suppliers:request': 'supplier', 'projects:request': 'project',
  'inventory:products': 'product', 'inventory:categories': 'category', 'inventory:warehouses': 'warehouse', 'inventory:units': 'unit', 'inventory:stock-entries': 'stockEntry',
  'sales:quotations': 'quotation', 'sales:orders': 'salesOrder', 'sales:sales-orders': 'salesOrder', 'sales:enquiries': 'salesEnquiry',
  'invoices:request': 'salesInvoice', 'invoicing:sales-invoices': 'salesInvoice', 'delivery-notes:request': 'deliveryNote',
  'hr:employees': 'employee', 'hr:departments': 'department', 'hr:positions': 'position',
  'procurement:material-requests': 'materialRequest', 'procurement:rfqs': 'requestForQuotation', 'procurement:purchase-orders': 'purchaseOrder', 'procurement:purchase-receipts': 'purchaseReceipt', 'procurement:purchase-invoices': 'purchaseInvoice',
};

function sanitizeAuditValue(value: any, depth = 0): any {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toJSON === 'function') return sanitizeAuditValue(value.toJSON(), depth);
  if (depth >= 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeAuditValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, sensitiveKeys.has(key) || /password|token|secret|credential/i.test(key) ? '[REDACTED]' : sanitizeAuditValue(item, depth + 1)]));
  return String(value);
}

function auditAction(req: Request) {
  const segments = req.path.split('/').filter(Boolean);
  const operation = segments[segments.length - 1]?.toUpperCase();
  if (operation && ['SUBMIT', 'CANCEL', 'AMEND', 'APPROVE', 'REJECT', 'CONVERT', 'POST', 'COMPLETE', 'DISPATCH', 'RECEIVE'].includes(operation)) return operation;
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
    if (existing.state === 'COMPLETED') return res.status(200).json(existing.responseBody);
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

export async function mutationAudit(req: AuthRequest, res: Response, next: NextFunction) {
  if (!mutationMethods.has(req.method)) return next();
  const pathParts = req.path.split('/').filter(Boolean);
  if (pathParts[0] === 'api') pathParts.shift();
  if (pathParts[0] === 'v1') pathParts.shift();
  const moduleName = pathParts[0] || 'system';
  const rootResource = ['customers', 'suppliers', 'projects', 'invoices', 'delivery-notes'].includes(moduleName);
  const resource = rootResource ? 'request' : pathParts[1] || 'request';
  const pathEntityId = ['PUT', 'PATCH', 'DELETE'].includes(req.method) ? pathParts[rootResource ? 1 : 2] : undefined;
  let beforeSnapshot: any;
  const delegateName = auditDelegates[`${moduleName}:${resource}`];
  if (pathEntityId && delegateName && (prisma as any)[delegateName]?.findUnique) {
    try { beforeSnapshot = await (prisma as any)[delegateName].findUnique({ where: { id: pathEntityId } }); }
    catch { beforeSnapshot = undefined; }
  }
  const originalJson = res.json.bind(res);
  res.json = ((body: any) => {
    if (req.user && res.statusCode >= 200 && res.statusCode < 400 && moduleName !== 'auth') {
      const responseData = body?.data;
      const entityId = req.params?.id || pathEntityId || responseData?.id || responseData?.data?.id;
      prisma.platformAuditLog.create({ data: {
        tenantId: req.user.tenantId || undefined,
        companyId: req.user.companyId,
        branchId: req.user.branchId || undefined,
        userId: req.user.id,
        entityType: `${moduleName}:${resource}`.toUpperCase(),
        entityId: entityId ? String(entityId) : undefined,
        action: auditAction(req),
        before: sanitizeAuditValue(beforeSnapshot),
        diff: sanitizeAuditValue(req.body || {}),
        after: sanitizeAuditValue(responseData),
        ip: req.ip,
        userAgent: req.get('user-agent'),
        requestId: req.context?.requestId,
      } }).catch(error => console.error('Unable to write audit log:', error));
    }
    return originalJson(body);
  }) as any;
  next();
}
