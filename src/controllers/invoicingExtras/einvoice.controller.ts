import { Request, Response } from 'express';
import QRCode from 'qrcode';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import * as einvoice from '../../services/einvoice/einvoice.service';
import * as config from '../../services/einvoice/einvoiceConfig.service';
import { CANCEL_REASON_CODES, RULE_VERSION_TEMPLATE } from '../../services/einvoice/einvoiceRules.service';

// Wraps a handler so EInvoiceError becomes a clean 4xx and anything else goes through the usual Prisma error mapping.
const handle = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { return await fn(req, res); }
  catch (err: any) {
    if (err instanceof einvoice.EInvoiceError) return error(res, err.message, err.status, err.details ? { problems: err.details } : undefined);
    return handlePrismaError(res, err);
  }
};

// The stored signed values are large; lists leave them out.
const LIST_SELECT = {
  id: true, status: true, sourceType: true, salesInvoiceId: true, creditNoteId: true, docType: true, docNo: true, docDate: true, buyerName: true, buyerGstin: true,
  sellerGstin: true, totalValue: true, irn: true, ackNo: true, ackDate: true, errorCode: true, errorMessage: true, exportedAt: true, reportingDeadline: true,
  cancelDeadline: true, createdAt: true, updatedAt: true,
};

const withExtras = async (row: any) => ({ ...row, validation: { errors: await einvoice.validationFor(prisma, row) }, cancel: await einvoice.cancelInfo(prisma, row) });

export const listEInvoices = handle(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const { status, search, salesInvoiceId, creditNoteId } = req.query as any;
  const where: any = {};
  if (status) where.status = status;
  if (salesInvoiceId) where.salesInvoiceId = salesInvoiceId;
  if (creditNoteId) where.creditNoteId = creditNoteId;
  if (search) where.OR = [{ docNo: { contains: search, mode: 'insensitive' } }, { irn: { contains: search, mode: 'insensitive' } }, { buyerName: { contains: search, mode: 'insensitive' } }];
  const [items, total] = await Promise.all([
    prisma.eInvoice.findMany({ where, select: LIST_SELECT, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.eInvoice.count({ where }),
  ]);
  return paginated(res, items, total, page, limit);
});

export const getEInvoice = handle(async (req, res) => success(res, await withExtras(await einvoice.getEInvoice(prisma, req.params.id))));

export const createEInvoice = handle(async (req, res) => {
  const result: any = await prisma.$transaction((tx) => einvoice.createFromSource(tx, req, req.body));
  if (result.preview) return success(res, { einvoice: result.einvoice, items: result.items, errors: result.errors, warnings: result.warnings, applicability: result.applicability });
  return success(res, { ...(await withExtras(await einvoice.getEInvoice(prisma, result.einvoice.id))), warnings: result.warnings, applicability: result.applicability }, 'E-invoice prepared', 201);
});

export const updateEInvoice = handle(async (req, res) => {
  const row = await prisma.$transaction((tx) => einvoice.updateDraft(tx, req, req.params.id, req.body));
  return success(res, await withExtras(row), 'E-invoice updated');
});

export const refreshEInvoice = handle(async (req, res) => {
  const result = await prisma.$transaction((tx) => einvoice.refreshFromSource(tx, req, req.params.id));
  return success(res, { ...(await withExtras(result.einvoice)), warnings: result.warnings }, 'E-invoice refreshed from the document');
});

export const deleteEInvoice = handle(async (req, res) => {
  await prisma.$transaction((tx) => einvoice.deleteDraft(tx, req, req.params.id));
  return success(res, null, 'E-invoice deleted');
});

// Returns the portal's bulk-upload file as a download. ids come from the body (POST) so a long selection fits.
export const exportEInvoices = handle(async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : req.params.id ? [req.params.id] : [];
  const file = await prisma.$transaction((tx) => einvoice.exportEInvoices(tx, req, ids));
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="einvoices-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.status(200).send(JSON.stringify(file, null, 2));
});

// The result file is uploaded as JSON text in `content` (or already parsed in `json`).
export const importEInvoiceResult = handle(async (req, res) => {
  let json = req.body?.json;
  if (json === undefined && typeof req.body?.content === 'string') {
    try { json = JSON.parse(req.body.content); } catch { return error(res, 'The file is not valid JSON. Upload the result file downloaded from the portal', 400); }
  }
  if (json === undefined) return error(res, 'Upload the portal result file', 400);
  const result = await prisma.$transaction((tx) => einvoice.importResult(tx, req, json));
  return success(res, result, `${result.accepted.length} of ${result.total} rows recorded`);
});

export const recordEInvoiceIrn = handle(async (req, res) => success(res, await withExtras(await prisma.$transaction((tx) => einvoice.recordIrn(tx, req, req.params.id, req.body))), 'IRN recorded'));
export const recordEInvoiceError = handle(async (req, res) => success(res, await withExtras(await prisma.$transaction((tx) => einvoice.recordError(tx, req, req.params.id, req.body))), 'Portal error recorded'));

export const cancelEInvoice = handle(async (req, res) => {
  const result = await prisma.$transaction((tx) => einvoice.recordCancel(tx, req, req.params.id, req.body));
  return success(res, { ...(await withExtras(result.einvoice)), warnings: result.warnings }, 'IRN cancellation recorded');
});

export const einvoiceQr = handle(async (req, res) => {
  const row = await einvoice.getEInvoice(prisma, req.params.id);
  if (row.status !== 'GENERATED' || !row.signedQr) return error(res, 'The QR code is available after the IRN is recorded', 400);
  res.setHeader('Content-Type', 'image/png');
  return res.send(await QRCode.toBuffer(row.signedQr, { errorCorrectionLevel: 'L', margin: 1, width: 480 }));
});

export const checkEInvoiceRequirement = handle(async (req, res) => {
  const { sourceType, sourceId } = req.query as any;
  if (!sourceType || !sourceId) return error(res, 'sourceType and sourceId are required', 400);
  if (!['SALES_INVOICE', 'CREDIT_NOTE'].includes(sourceType)) return error(res, 'sourceType must be SALES_INVOICE or CREDIT_NOTE', 400);
  return success(res, await einvoice.checkRequirement(prisma, sourceType, sourceId));
});

export const unreportedEInvoices = handle(async (req, res) => success(res, await einvoice.unreportedReport(prisma, parseInt(req.query.days as string) || 60)));
export const failedEInvoices = handle(async (_req, res) => success(res, await einvoice.failedReport(prisma)));
export const einvoiceSellerGstins = handle(async (_req, res) => {
  const { dispatchGstinOptions } = await import('../../services/eway/ewayBill.service');
  return success(res, await dispatchGstinOptions(prisma));
});

// Settings: config, rule versions (with the prefill template), PAN turnover.
export const getEInvoiceSettings = handle(async (_req, res) => success(res, {
  config: await config.getConfig(prisma),
  ruleVersions: await config.listRuleVersions(prisma),
  turnover: await config.listTurnover(prisma),
  template: RULE_VERSION_TEMPLATE,
  cancelReasons: CANCEL_REASON_CODES,
}));
export const getCompanyGstProfile = handle(async (_req, res) => success(res, await config.getCompanyProfile(prisma)));
export const updateCompanyGstProfile = handle(async (req, res) => success(res, await prisma.$transaction((tx) => config.updateCompanyProfile(tx, req, req.body)), 'Company GST details saved'));
export const einvoiceReadiness = handle(async (_req, res) => success(res, await config.readiness(prisma)));
export const updateEInvoiceConfig = handle(async (req, res) => success(res, await prisma.$transaction((tx) => config.updateConfig(tx, req, req.body)), 'E-invoice settings saved'));
export const createRuleVersion = handle(async (req, res) => success(res, await prisma.$transaction((tx) => config.createRuleVersion(tx, req, req.body)), 'Rule version added', 201));
export const verifyRuleVersion = handle(async (req, res) => success(res, await prisma.$transaction((tx) => config.verifyRuleVersion(tx, req, req.params.id, req.body)), 'Rule version verified'));
export const setEInvoiceTurnover = handle(async (req, res) => success(res, await prisma.$transaction((tx) => config.setTurnover(tx, req, req.body)), 'Turnover saved'));
