import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success, paginated, error } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getProducts = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { categoryId, type, search, isActive } = req.query as any;
    const where: any = {};
    if (categoryId) where.categoryId = categoryId;
    if (type) where.type = type;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { sku: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { category: true, unit: true, stockLevels: { include: { warehouse: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.product.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getProduct = async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { category: true, unit: true, stockLevels: { include: { warehouse: true } } },
    });
    if (!product) return error(res, 'Product not found', 404);
    return success(res, product);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const searchProducts = async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return success(res, []);
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        sku: true,
        name: true,
        salePrice: true,
        taxRate: true,
        unitId: true,
        unit: { select: { id: true, name: true, symbol: true } },
      },
      orderBy: { name: 'asc' },
      take: 20,
    });
    return success(res, products.map((p: any) => ({
      ...p,
      salePrice: Number(p.salePrice || 0),
      taxRate: Number(p.taxRate || 0),
    })));
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createProduct = async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.create({
      data: req.body,
      include: { category: true, unit: true },
    });
    return success(res, product, 'Product created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateProduct = async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: req.body,
      include: { category: true, unit: true },
    });
    return success(res, product, 'Product updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteProduct = async (req: Request, res: Response) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    return success(res, null, 'Product deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
