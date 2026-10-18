import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { renderEwayBillPdf } from '../../utils/pdf';
import * as eway from '../../services/eway/ewayBill.service';

// Wraps a handler so EwayError becomes a clean 4xx and anything else goes through the usual Prisma error mapping.
const handle = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { return await fn(req, res); }
  catch (err: any) {
    if (err instanceof eway.EwayError) return error(res, err.message, err.status, err.details ? { problems: err.details } : undefined);
    return handlePrismaError(res, err);
  }
};

const withValidation = (bill: any) => ({ ...bill, validation: { errors: eway.validationFor(bill) } });

export const listEwayBills = handle(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const { status, search, salesInvoiceId, deliveryNoteId } = req.query as any;
  const where: any = {};
  if (status) where.status = status;
  if (salesInvoiceId) where.salesInvoiceId = salesInvoiceId;
  if (deliveryNoteId) where.deliveryNoteId = deliveryNoteId;
  if (search) where.OR = [{ billNo: { contains: search, mode: 'insensitive' } }, { docNo: { contains: search, mode: 'insensitive' } }, { ewbNo: { contains: search } }, { toName: { contains: search, mode: 'insensitive' } }];
  const [items, total] = await Promise.all([
    prisma.ewayBill.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.ewayBill.count({ where }),
  ]);
  return paginated(res, items, total, page, limit);
});

export const getEwayBill = handle(async (req, res) => success(res, withValidation(await eway.getBill(prisma, req.params.id))));

export const createEwayBill = handle(async (req, res) => {
  const result: any = await prisma.$transaction((tx) => eway.createBill(tx, req, req.body));
  if (result.preview) return success(res, { bill: result.bill, errors: result.errors, warnings: result.warnings });
  return success(res, { ...withValidation(result.bill), warnings: result.warnings }, 'E-way bill draft created', 201);
});

export const updateEwayBill = handle(async (req, res) => {
  const bill = await prisma.$transaction((tx) => eway.updateDraft(tx, req, req.params.id, req.body));
  return success(res, withValidation(bill), 'E-way bill updated');
});

export const deleteEwayBill = handle(async (req, res) => {
  await prisma.$transaction((tx) => eway.deleteDraft(tx, req, req.params.id));
  return success(res, null, 'E-way bill deleted');
});

// Returns the NIC bulk-upload file as a download. ids come from the body (POST) so a long selection fits.
export const exportEwayBills = handle(async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : req.params.id ? [req.params.id] : [];
  const file = await prisma.$transaction((tx) => eway.exportBills(tx, req, ids));
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="eway-bills-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.status(200).send(JSON.stringify(file, null, 2));
});

export const recordEwayNumber = handle(async (req, res) => success(res, withValidation(await prisma.$transaction((tx) => eway.recordNumber(tx, req, req.params.id, req.body))), 'E-way bill number recorded'));

export const cancelEwayBill = handle(async (req, res) => {
  const result = await prisma.$transaction((tx) => eway.recordCancel(tx, req, req.params.id, req.body));
  return success(res, { ...result.bill, warnings: result.warnings }, 'E-way bill cancellation recorded');
});

export const updateEwayVehicle = handle(async (req, res) => success(res, await prisma.$transaction((tx) => eway.recordVehicle(tx, req, req.params.id, req.body)), 'Vehicle change recorded'));
export const extendEwayBill = handle(async (req, res) => success(res, await prisma.$transaction((tx) => eway.recordExtension(tx, req, req.params.id, req.body)), 'Extension recorded'));

export const ewayBillPdf = handle(async (req, res) => {
  const bill = await eway.getBill(prisma, req.params.id);
  if (bill.status === 'DRAFT' || bill.status === 'EXPORTED') return error(res, 'The printed copy is available after the e-way bill number is recorded', 400);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${bill.ewbNo || bill.billNo}.pdf"`);
  return res.send(renderEwayBillPdf(bill));
});

export const pendingEwayBills = handle(async (req, res) => success(res, await eway.pendingReport(prisma, parseInt(req.query.days as string) || 30)));
export const expiringEwayBills = handle(async (req, res) => success(res, await eway.expiringSoon(prisma, parseInt(req.query.hours as string) || 24)));
export const checkEwayRequirement = handle(async (req, res) => {
  const { sourceType, sourceId } = req.query as any;
  if (!sourceType || !sourceId) return error(res, 'sourceType and sourceId are required', 400);
  return success(res, await eway.checkRequirement(prisma, sourceType, sourceId));
});
export const ewayDispatchGstins = handle(async (_req, res) => success(res, await eway.dispatchGstinOptions(prisma)));
export const getEwayConfig = handle(async (_req, res) => success(res, await eway.getConfig(prisma)));
export const updateEwayConfig = handle(async (req, res) => success(res, await prisma.$transaction((tx) => eway.updateConfig(tx, req, req.body)), 'E-way bill settings saved'));
