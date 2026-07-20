import { Prisma } from '@prisma/client';

const D = Prisma.Decimal;
type Tx = any;

export async function resolveItemPricing(tx: Tx, input: {
  product: any;
  customerId?: string;
  priceListId?: string;
  quantity?: Prisma.Decimal.Value;
  currency?: string;
  explicitRate?: Prisma.Decimal.Value;
  explicitDiscount?: Prisma.Decimal.Value;
}) {
  const quantity = new D(input.quantity || 1);
  let rate = input.explicitRate !== undefined && input.explicitRate !== null
    ? new D(input.explicitRate)
    : new D(input.product.salePrice || 0);
  let discount = new D(input.explicitDiscount || 0);

  const today = new Date();
  const itemPrice = await tx.itemPrice.findFirst({
    where: {
      productId: input.product.id,
      currency: input.currency || undefined,
      OR: [
        { customerId: input.customerId || undefined },
        { customerId: null },
      ],
      ...(input.priceListId ? { priceListId: input.priceListId } : {}),
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: today } }] },
        { OR: [{ validTo: null }, { validTo: { gte: today } }] },
      ],
    },
    orderBy: [{ customerId: 'desc' }, { updatedAt: 'desc' }],
  });
  if (itemPrice && input.explicitRate === undefined) rate = new D(itemPrice.price);

  const rule = await tx.pricingRule.findFirst({
    where: {
      isActive: true,
      OR: [
        { productId: input.product.id },
        { categoryId: input.product.categoryId || undefined },
        { productId: null, categoryId: null },
      ],
      AND: [
        { OR: [{ customerId: input.customerId || undefined }, { customerId: null }] },
        { OR: [{ priceListId: input.priceListId || undefined }, { priceListId: null }] },
        { OR: [{ minQty: null }, { minQty: { lte: quantity } }] },
        { OR: [{ maxQty: null }, { maxQty: { gte: quantity } }] },
        { OR: [{ validFrom: null }, { validFrom: { lte: today } }] },
        { OR: [{ validTo: null }, { validTo: { gte: today } }] },
      ],
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  if (rule) {
    if (new D(rule.marginPercent || 0).gt(0)) {
      rate = new D(input.product.costPrice || 0).mul(new D(1).plus(new D(rule.marginPercent).div(100)));
    }
    if (input.explicitDiscount === undefined) discount = new D(rule.discountPercent || 0);
  }

  return { rate, discount, rule };
}
