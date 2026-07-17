import { Prisma } from '@prisma/client';

export async function normalizeSalesItems(tx: any, items: any[] = []) {
  const normalized = [];
  let subtotal = new Prisma.Decimal(0);
  let taxAmount = new Prisma.Decimal(0);

  for (const item of items) {
    const itemCode = String(item.itemCode || item.sku || '').trim();
    let product = item.productId ? await tx.product.findUnique({ where: { id: item.productId } }) : null;
    if (!product && itemCode) product = await tx.product.findFirst({ where: { sku: itemCode } });
    if (!product) {
      const sku = itemCode || `MISC-${Date.now()}-${normalized.length + 1}`;
      product = await tx.product.create({
        data: {
          sku,
          name: item.description || sku,
          description: item.description,
          type: 'SERVICE',
          salePrice: new Prisma.Decimal(item.unitPrice ?? item.rate ?? 0),
          taxRate: new Prisma.Decimal(item.taxRate || 0),
          isActive: true,
        },
      });
    }

    const quantity = new Prisma.Decimal(item.quantity || 0);
    const unitPrice = new Prisma.Decimal(item.unitPrice ?? item.rate ?? product.salePrice ?? 0);
    const discount = new Prisma.Decimal(item.discount || 0);
    const taxRate = new Prisma.Decimal(item.taxRate ?? product.taxRate ?? 0);
    const net = quantity.mul(unitPrice).mul(new Prisma.Decimal(1).minus(discount.div(100)));
    const lineTax = net.mul(taxRate.div(100));
    const total = net.plus(lineTax);
    subtotal = subtotal.plus(net);
    taxAmount = taxAmount.plus(lineTax);
    normalized.push({ productId: product.id, description: item.description || product.description || product.name, quantity, unitPrice, taxRate, discount, total });
  }

  return { items: normalized, subtotal, taxAmount };
}
