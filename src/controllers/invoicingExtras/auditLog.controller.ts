import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { moduleAuditWhere } from '../../utils/auditQuery';

// Document history for the invoicing module (invoice, delivery note, credit note, payment entry).
// It reads the central PlatformAuditLog through the INVOICING module filter, scoped to the caller's
// tenant and company, and is gated by the invoicing:audit-log permission (requireModuleAccess), so
// it does not need the access:audit permission of GET /platform/audit.
const voucherSources = [
  { entityType: 'SALES_INVOICE', key: 'invoice', field: 'invoiceNo', load: (ids: string[]) => prisma.salesInvoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNo: true } }) },
  { entityType: 'DELIVERY_NOTE', key: 'deliveryNote', field: 'deliveryNo', load: (ids: string[]) => prisma.deliveryNote.findMany({ where: { id: { in: ids } }, select: { id: true, deliveryNo: true } }) },
  { entityType: 'CREDIT_NOTE', key: 'creditNote', field: 'creditNoteNo', load: (ids: string[]) => prisma.creditNote.findMany({ where: { id: { in: ids } }, select: { id: true, creditNoteNo: true } }) },
  { entityType: 'PAYMENT_ENTRY', key: 'paymentEntry', field: 'paymentNo', load: (ids: string[]) => prisma.paymentEntry.findMany({ where: { id: { in: ids } }, select: { id: true, paymentNo: true } }) },
] as const;

const text = (value: unknown) => String(value ?? '').trim();

function dayBounds(from: unknown, to: unknown) {
  const gte = from ? new Date(text(from)) : undefined;
  const lte = to ? new Date(`${text(to).slice(0, 10)}T23:59:59.999Z`) : undefined;
  const createdAt = { ...(gte && !Number.isNaN(gte.getTime()) ? { gte } : {}), ...(lte && !Number.isNaN(lte.getTime()) ? { lte } : {}) };
  return Object.keys(createdAt).length ? createdAt : undefined;
}

export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user || {};
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const entityType = text(req.query.entityType).toUpperCase();
    const action = text(req.query.action).toUpperCase();
    const search = text(req.query.search);
    const createdAt = dayBounds(req.query.fromDate, req.query.toDate);
    const and: any[] = [moduleAuditWhere('INVOICING')];
    if (search) {
      and.push({ OR: ['message', 'actorEmail', 'actorRole', 'entityId', 'action', 'entityType'].map((field) => ({ [field]: { contains: search, mode: 'insensitive' } })) });
    }
    const where: any = {
      tenantId: user.tenantId,
      companyId: user.companyId,
      ...(entityType ? { entityType } : {}),
      ...(action ? { action } : {}),
      ...(createdAt ? { createdAt } : {}),
      AND: and,
    };
    const [rows, count] = await Promise.all([
      prisma.platformAuditLog.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.platformAuditLog.count({ where }),
    ]);
    // The page shows the voucher number, not the internal id: resolve it per document type.
    const numbers = new Map<string, { key: string; voucherNo: string }>();
    await Promise.all(voucherSources.map(async (source) => {
      const ids = [...new Set(rows.filter((row) => row.entityType === source.entityType && row.entityId).map((row) => row.entityId as string))];
      if (!ids.length) return;
      for (const doc of (await source.load(ids)) as any[]) numbers.set(doc.id, { key: source.key, voucherNo: doc[source.field] });
    }));
    // voucherNo is the plain value; the nested invoice/deliveryNote/creditNote/paymentEntry object keeps
    // the shape the page already reads.
    const items = rows.map((row) => {
      const found = row.entityId ? numbers.get(row.entityId) : undefined;
      const source = found && voucherSources.find((entry) => entry.key === found.key);
      return found && source ? { ...row, [found.key]: { [source.field]: found.voucherNo }, voucherNo: found.voucherNo } : row;
    });
    return success(res, { items, total: count, page, limit, totalPages: Math.max(1, Math.ceil(count / limit)) });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
