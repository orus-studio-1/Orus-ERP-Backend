import { Response } from 'express';
import { error } from './response';

export function handlePrismaError(res: Response, err: any) {
  const code = err?.code;
  const rawMessage = String(err?.message || '');

  console.error('Prisma/API error:', {
    code,
    message: err?.message,
    meta: err?.meta,
  });

  if (code === 'P2002' || rawMessage.includes('Unique constraint failed')) {
    const targets = Array.isArray(err?.meta?.target) ? err.meta.target : [];
    let field = targets.find((target: string) => target !== 'companyId') || targets[0];
    if (!field) {
      const match = rawMessage.match(/Unique constraint failed on the fields?:\s*\(([^)]+)\)/i);
      if (match && match[1]) {
        field = match[1].replace(/[`"]/g, '').trim();
      }
    }
    const label =
      field === 'entryNo'
        ? 'Stock Entry number'
        : field === 'invoiceNo'
        ? 'Invoice number'
        : field === 'orderNo'
        ? 'Order number'
        : field === 'quotationNo'
        ? 'Quotation number'
        : field === 'email'
        ? 'Email'
        : field
        ? `${field}`
        : 'identifier';
    return error(res, `A record with this ${label} already exists. Please try again.`, 400);
  }

  if (code === 'P2003' || rawMessage.includes('Foreign key constraint failed')) {
    return error(res, 'Related record not found. Check that referenced items exist.', 400);
  }
  if (code === 'P2025' || rawMessage.includes('Record to update not found') || rawMessage.includes('Record to delete not found')) {
    return error(res, 'Record not found.', 404);
  }
  if (code === 'P2014') {
    return error(res, 'This action would violate a required relationship.', 400);
  }
  if (code === 'P2011' || rawMessage.includes('Null constraint violation')) {
    return error(res, 'A required field is missing.', 400);
  }
  if (err?.name === 'PrismaClientValidationError' || (rawMessage.includes('Argument') && rawMessage.includes('is missing'))) {
    return error(res, 'The request contains an unsupported or missing field. Please check your form values.', 400);
  }
  if (code === 'P2021') {
    return error(res, 'Database table is missing. Run Prisma db push/migrate and restart the backend.', 400, process.env.NODE_ENV === 'production' ? undefined : err?.meta);
  }
  if (code === 'P2022') {
    return error(res, 'Database column is missing. Run Prisma db push/migrate and restart the backend.', 400, process.env.NODE_ENV === 'production' ? undefined : err?.meta);
  }
  if (code === 'P2028') {
    return error(res, 'Database transaction timed out. Please try again.', 400);
  }
  if (code?.startsWith('P')) {
    return error(res, 'Database operation failed. Please check your input and try again.', 400);
  }

  // Filter out internal prisma file paths / stack traces from message
  if (rawMessage) {
    if (rawMessage.includes('Invalid `') || rawMessage.includes('prisma_1.default') || rawMessage.includes('.controller.js') || rawMessage.includes('prisma')) {
      return error(res, 'Unable to complete request due to a database validation constraint. Please check your entries and try again.', 400);
    }
    return error(res, rawMessage, 400);
  }

  return error(res, 'Something went wrong. Please try again.', 500);
}
