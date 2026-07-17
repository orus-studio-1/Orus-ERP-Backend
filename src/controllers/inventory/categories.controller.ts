import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getCategories = async (req: Request, res: Response) => {
  try {
    const cats = await prisma.category.findMany({
      include: { parent: true, children: true, _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    });
    return success(res, cats);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createCategory = async (req: Request, res: Response) => {
  try {
    const cat = await prisma.category.create({ data: req.body });
    return success(res, cat, 'Category created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateCategory = async (req: Request, res: Response) => {
  try {
    const cat = await prisma.category.update({ where: { id: req.params.id }, data: req.body });
    return success(res, cat, 'Category updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  try {
    await prisma.category.delete({ where: { id: req.params.id } });
    return success(res, null, 'Category deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
