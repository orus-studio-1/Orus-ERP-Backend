import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';
import { AuthRequest } from '../../middleware/auth';

export const getContacts = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { search } = req.query as any;
    const where: any = { isActive: true };
    if (search) where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.contact.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createContact = async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.create({ data: req.body });
    return success(res, contact, 'Contact created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateContact = async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.update({ where: { id: req.params.id }, data: req.body });
    return success(res, contact, 'Contact updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteContact = async (req: Request, res: Response) => {
  try {
    await prisma.contact.delete({ where: { id: req.params.id } });
    return success(res, null, 'Contact deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
