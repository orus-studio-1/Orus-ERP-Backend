import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { serializeMoney } from '../../utils/invoice';

export const getLedgerEntries = async (req: Request, res: Response) => {
  try {
    const { invoiceId, paymentEntryId, creditNoteId, accountId } = req.query as any;
    const entries = await prisma.generalLedgerEntry.findMany({
      where: { invoiceId, paymentEntryId, creditNoteId, accountId },
      include: { account: { select: { code: true, name: true, type: true } } },
      orderBy: { postingDate: 'desc' },
    });
    return success(res, entries.map((entry: any) => ({ ...entry, debit: serializeMoney(entry.debit), credit: serializeMoney(entry.credit) })));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getPrintFormats = async (_req: Request, res: Response) => {
  try {
    const formats = await prisma.printFormat.findMany({ orderBy: { name: 'asc' } });
    return success(res, formats);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createPrintFormat = async (req: Request, res: Response) => {
  try {
    const format = await prisma.printFormat.create({
      data: {
        name: req.body.name,
        docType: req.body.docType || 'SALES_INVOICE',
        isDefault: !!req.body.isDefault,
        template: req.body.template || { sections: ['header', 'customer', 'items', 'taxes', 'totals', 'terms'] },
        letterhead: req.body.letterhead,
        footer: req.body.footer,
      },
    });
    return success(res, format, 'Print format created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
