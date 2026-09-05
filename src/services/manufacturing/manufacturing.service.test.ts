import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { assertQuantityReconciliation, explodeBom, validateBomLines } from './manufacturing.service';

describe('manufacturing BOM rules', () => {
  it('rejects direct circular references', () => {
    expect(() => validateBomLines('FG', 1, [{ lineNumber: 1, itemId: 'FG', qty: 1 }])).toThrow('BOM_CIRCULAR_REFERENCE');
  });

  it('rejects invalid quantities and percentages', () => {
    expect(() => validateBomLines('FG', 1, [{ lineNumber: 1, itemId: 'RM', qty: 0 }])).toThrow('positive');
    expect(() => validateBomLines('FG', 1, [{ lineNumber: 1, itemId: 'RM', qty: 1, scrapPercent: 101 }])).toThrow('between 0 and 100');
  });

  it('explodes a three-level BOM with loss at every level', async () => {
    const children: Record<string, any> = {
      SUB: { itemId: 'SUB', quantity: new Prisma.Decimal(1), items: [{ itemId: 'RM', qty: 2, stockQty: 2, conversionFactor: 1, scrapPercent: 10, wastagePercent: 0 }] },
    };
    const tx: any = { bom: { findFirst: ({ where }: any) => Promise.resolve(children[where.itemId] || null) } };
    const result = await explodeBom(tx, { companyId: 'C', itemId: 'FG', quantity: new Prisma.Decimal(1), items: [{ itemId: 'SUB', qty: 3, stockQty: 3, conversionFactor: 1, scrapPercent: 5, wastagePercent: 0 }] });
    expect(result).toHaveLength(2);
    expect(result[0].cumulativeQty.toString()).toBe('3.15');
    expect(result[1].cumulativeQty.toString()).toBe('6.93');
    expect(result[1].lowLevelCode).toBe(2);
  });
});

describe('shop-floor quantity rules', () => {
  it('accepts reconciled quantities', () => expect(() => assertQuantityReconciliation({ plannedQty: 100, completedQty: 80, rejectedQty: 10, reworkQty: 5, scrapQty: 5 })).not.toThrow());
  it('rejects quantities above plan', () => expect(() => assertQuantityReconciliation({ plannedQty: 100, completedQty: 90, rejectedQty: 10, reworkQty: 5, scrapQty: 0 })).toThrow('exceed'));
});
