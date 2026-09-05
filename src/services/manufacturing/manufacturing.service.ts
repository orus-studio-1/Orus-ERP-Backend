import { Prisma } from '@prisma/client';

const D = Prisma.Decimal;
type Tx = any;

export type ExplodedComponent = {
  level: number;
  itemId: string;
  parentItemId: string;
  qtyPerUnit: Prisma.Decimal;
  cumulativeQty: Prisma.Decimal;
  lowLevelCode: number;
  path: string;
};

export function validateBomLines(itemId: string, quantity: Prisma.Decimal.Value, items: any[]) {
  if (new D(quantity).lte(0)) throw new Error('BOM quantity must be positive');
  if (!items.length) throw new Error('A BOM requires at least one component');
  const lines = new Set<number>();
  for (const item of items) {
    if (!item.itemId) throw new Error('Every BOM component requires an item');
    if (item.itemId === itemId) throw new Error('BOM_CIRCULAR_REFERENCE');
    if (new D(item.qty || 0).lte(0)) throw new Error('Component quantities must be positive');
    if (new D(item.scrapPercent || 0).lt(0) || new D(item.scrapPercent || 0).gt(100)) throw new Error('Scrap percentage must be between 0 and 100');
    if (new D(item.wastagePercent || 0).lt(0) || new D(item.wastagePercent || 0).gt(100)) throw new Error('Wastage percentage must be between 0 and 100');
    const line = Number(item.lineNumber);
    if (!Number.isInteger(line) || line < 1 || lines.has(line)) throw new Error('BOM line numbers must be unique positive integers');
    lines.add(line);
  }
}

export async function explodeBom(tx: Tx, bom: any): Promise<ExplodedComponent[]> {
  const output: ExplodedComponent[] = [];
  const visit = async (current: any, multiplier: Prisma.Decimal, level: number, ancestors: string[]) => {
    if (ancestors.includes(current.itemId)) throw new Error('BOM_CIRCULAR_REFERENCE');
    const nextAncestors = [...ancestors, current.itemId];
    for (const line of current.items) {
      if (nextAncestors.includes(line.itemId)) throw new Error('BOM_CIRCULAR_REFERENCE');
      const lossFactor = new D(1).plus(new D(line.scrapPercent || 0).plus(line.wastagePercent || 0).div(100));
      const perParent = new D(line.stockQty || new D(line.qty).mul(line.conversionFactor || 1)).mul(lossFactor).div(current.quantity || 1);
      const cumulative = multiplier.mul(perParent);
      output.push({ level, itemId: line.itemId, parentItemId: current.itemId, qtyPerUnit: perParent, cumulativeQty: cumulative, lowLevelCode: level, path: [...nextAncestors, line.itemId].join('>') });
      const child = await tx.bom.findFirst({
        where: { companyId: bom.companyId, itemId: line.itemId, status: 'ACTIVE', isDefault: true, isActive: true },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
        orderBy: { revisionNumber: 'desc' },
      });
      if (child) await visit(child, cumulative, level + 1, nextAncestors);
    }
  };
  await visit(bom, new D(1), 1, []);
  const deepest = new Map<string, number>();
  for (const row of output) deepest.set(row.itemId, Math.max(deepest.get(row.itemId) || 0, row.level));
  return output.map(row => ({ ...row, lowLevelCode: deepest.get(row.itemId) || row.level }));
}

export async function validateBomActivation(tx: Tx, bom: any) {
  validateBomLines(bom.itemId, bom.quantity, bom.items);
  const ids = [bom.itemId, ...bom.items.flatMap((item: any) => [item.itemId, ...(item.alternativeItemIds || [])])];
  const products = await tx.product.findMany({ where: { id: { in: [...new Set(ids)] }, isActive: true }, select: { id: true } });
  if (products.length !== new Set(ids).size) throw new Error('Every BOM item and alternative must exist and be active');
  if (bom.effectiveFrom && bom.effectiveTo && bom.effectiveFrom > bom.effectiveTo) throw new Error('BOM effective date range is invalid');
  const overlap = await tx.bom.findFirst({
    where: {
      id: { not: bom.id }, companyId: bom.companyId, itemId: bom.itemId, isDefault: true, status: 'ACTIVE',
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: bom.effectiveFrom || new Date(0) } }] }, { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: bom.effectiveTo || new Date('9999-12-31') } }] }],
    },
  });
  if (bom.isDefault && overlap) throw new Error('An active default BOM already overlaps this effective date range');
  return explodeBom(tx, bom);
}

export async function bomCost(tx: Tx, bom: any) {
  const ids = [...new Set(bom.items.map((item: any) => item.itemId))] as string[];
  const products = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, costPrice: true } });
  const rates = new Map(products.map((product: any) => [product.id, new D(product.costPrice || 0)]));
  const rawMaterialCost = bom.items.reduce((sum: Prisma.Decimal, item: any) => item.includeInManufacturingCost ? sum.plus(new D(item.stockQty).mul(new D(item.rate || rates.get(item.itemId) || 0))) : sum, new D(0));
  const scrapValue = bom.scrapItems.reduce((sum: Prisma.Decimal, item: any) => sum.plus(new D(item.qty).mul(item.rate || 0)), new D(0));
  let operatingCost = new D(0), overheadCost = new D(0);
  if (bom.routingId) {
    const routing = await tx.routing.findUnique({ where: { id: bom.routingId }, include: { operations: true } });
    if (routing) for (const operation of routing.operations) {
      const wc = await tx.workCenter.findUnique({ where: { id: operation.workCenterId } });
      if (!wc) continue;
      const hours = new D(operation.setupTimeMinutes).plus(new D(operation.cycleTimeMinutes).mul(bom.quantity).div(operation.batchSize || 1)).div(60);
      operatingCost = operatingCost.plus(hours.mul(wc.hourlyRate).plus(new D(operation.setupTimeMinutes).div(60).mul(wc.setupRate)));
      overheadCost = overheadCost.plus(hours.mul(wc.overheadRate));
    }
  }
  return { rawMaterialCost, operatingCost, overheadCost, scrapValue, totalCost: rawMaterialCost.plus(operatingCost).plus(overheadCost).minus(scrapValue) };
}

export function assertQuantityReconciliation(input: { completedQty: Prisma.Decimal.Value; rejectedQty: Prisma.Decimal.Value; reworkQty: Prisma.Decimal.Value; scrapQty: Prisma.Decimal.Value; plannedQty: Prisma.Decimal.Value }) {
  const accounted = new D(input.completedQty).plus(input.rejectedQty).plus(input.reworkQty).plus(input.scrapQty);
  if (accounted.gt(input.plannedQty)) throw new Error('Production, rejection, rework and scrap exceed planned quantity');
}
