import { Response } from 'express';
import { error } from './response';

export function handlePrismaError(res: Response, err: any) {
  const code = err?.code;

  if (code === 'P2002') {
    const field = err?.meta?.target?.[0] || 'field';
    return error(res, `A record with this ${field} already exists.`, 400);
  }
  if (code === 'P2003') {
    return error(res, 'Related record not found. Check that referenced items exist.', 400);
  }
  if (code === 'P2025') {
    return error(res, 'Record not found.', 404);
  }
  if (code === 'P2014') {
    return error(res, 'This action would violate a required relationship.', 400);
  }
  if (code === 'P2011') {
    return error(res, 'A required field is missing.', 400);
  }
  if (code?.startsWith('P')) {
    return error(res, 'Database error. Please check your input and try again.', 400);
  }

  return error(res, 'Something went wrong. Please try again.', 500);
}
