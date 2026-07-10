import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';

// ---- PRODUCTS ----
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

// ---- CATEGORIES ----
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

// ---- WAREHOUSES ----
export const getWarehouses = async (req: Request, res: Response) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      include: { _count: { select: { stockLevels: true } } },
      orderBy: { name: 'asc' },
    });
    return success(res, warehouses);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createWarehouse = async (req: Request, res: Response) => {
  try {
    const wh = await prisma.warehouse.create({ data: req.body });
    return success(res, wh, 'Warehouse created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateWarehouse = async (req: Request, res: Response) => {
  try {
    const wh = await prisma.warehouse.update({ where: { id: req.params.id }, data: req.body });
    return success(res, wh, 'Warehouse updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteWarehouse = async (req: Request, res: Response) => {
  try {
    await prisma.warehouse.delete({ where: { id: req.params.id } });
    return success(res, null, 'Warehouse deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- STOCK MOVEMENTS ----
export const getStockMovements = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { productId, warehouseId, type } = req.query as any;
    const where: any = {};
    if (productId) where.productId = productId;
    if (warehouseId) where.warehouseId = warehouseId;
    if (type) where.type = type;

    const [items, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.stockMovement.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createStockMovement = async (req: Request, res: Response) => {
  try {
    const { productId, warehouseId, type, quantity, unitCost, reference, notes } = req.body;

    const movement = await prisma.stockMovement.create({
      data: { productId, warehouseId, type, quantity, unitCost, reference, notes },
      include: { product: true, warehouse: true },
    });

    // Update stock level
    const multiplier = type === 'OUT' ? -1 : 1;
    await prisma.stockLevel.upsert({
      where: { productId_warehouseId: { productId, warehouseId } },
      update: { quantity: { increment: quantity * multiplier } },
      create: { productId, warehouseId, quantity: quantity * multiplier },
    });

    return success(res, movement, 'Stock movement recorded', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- UNITS ----
export const getUnits = async (req: Request, res: Response) => {
  try {
    const units = await prisma.unit.findMany({ orderBy: { name: 'asc' } });
    return success(res, units);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createUnit = async (req: Request, res: Response) => {
  try {
    const unit = await prisma.unit.create({ data: req.body });
    return success(res, unit, 'Unit created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteUnit = async (req: Request, res: Response) => {
  try {
    await prisma.unit.delete({ where: { id: req.params.id } });
    return success(res, null, 'Unit deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
