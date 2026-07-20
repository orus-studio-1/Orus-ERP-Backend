import { Prisma } from '@prisma/client';
import { defaultWarehouse } from '../../utils/erp';

const D = Prisma.Decimal;

type Tx = any;

export async function stockSnapshot(tx: Tx, productId: string, warehouseId: string) {
  const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } });
  return {
    quantity: new D(level?.quantity || 0),
    reservedQty: new D(level?.reservedQty || 0),
  };
}

async function movingAverageRate(tx: Tx, productId: string, warehouseId: string, incomingQty: Prisma.Decimal, incomingRate: Prisma.Decimal) {
  const current = await stockSnapshot(tx, productId, warehouseId);
  const last = await tx.stockLedgerEntry.findFirst({
    where: { productId, warehouseId, isCancelled: false },
    orderBy: [{ postingDate: 'desc' }, { createdAt: 'desc' }],
  });
  const oldRate = new D(last?.valuationRate || 0);
  const newQty = current.quantity.plus(incomingQty);
  if (newQty.lte(0)) return incomingRate;
  return current.quantity.mul(oldRate).plus(incomingQty.mul(incomingRate)).div(newQty);
}

async function fifoOutgoingRate(tx: Tx, productId: string, warehouseId: string, qty: Prisma.Decimal) {
  let remaining = qty.abs();
  let value = new D(0);
  const layers = await tx.inventoryValuationLayer.findMany({
    where: { productId, warehouseId, isClosed: false, remainingQty: { gt: 0 } },
    orderBy: [{ postingDate: 'asc' }, { createdAt: 'asc' }],
  });
  for (const layer of layers) {
    if (remaining.lte(0)) break;
    const take = D.min(new D(layer.remainingQty), remaining);
    value = value.plus(take.mul(layer.rate));
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) {
    const last = await tx.stockLedgerEntry.findFirst({
      where: { productId, warehouseId, isCancelled: false },
      orderBy: [{ postingDate: 'desc' }, { createdAt: 'desc' }],
    });
    value = value.plus(remaining.mul(last?.valuationRate || 0));
  }
  return qty.abs().gt(0) ? value.div(qty.abs()) : new D(0);
}

async function consumeFifoLayers(tx: Tx, productId: string, warehouseId: string, qty: Prisma.Decimal) {
  let remaining = qty.abs();
  const layers = await tx.inventoryValuationLayer.findMany({
    where: { productId, warehouseId, isClosed: false, remainingQty: { gt: 0 } },
    orderBy: [{ postingDate: 'asc' }, { createdAt: 'asc' }],
  });
  for (const layer of layers) {
    if (remaining.lte(0)) break;
    const take = D.min(new D(layer.remainingQty), remaining);
    const newRemaining = new D(layer.remainingQty).minus(take);
    await tx.inventoryValuationLayer.update({
      where: { id: layer.id },
      data: { remainingQty: newRemaining, isClosed: newRemaining.lte(0) },
    });
    remaining = remaining.minus(take);
  }
}

export async function postStockLedger(tx: Tx, input: {
  productId: string;
  warehouseId?: string;
  actualQty: Prisma.Decimal.Value;
  rate?: Prisma.Decimal.Value;
  postingDate?: Date;
  voucherType: string;
  voucherId?: string;
  voucherNo: string;
  remarks?: string;
  batchId?: string;
  serialNoId?: string;
}) {
  const warehouse = await defaultWarehouse(tx, input.warehouseId);
  const product = await tx.product.findUnique({ where: { id: input.productId } });
  if (!product || product.type !== 'PRODUCT' || product.maintainStock === false) return null;

  const actualQty = new D(input.actualQty || 0);
  if (actualQty.eq(0)) return null;
  if (product.hasBatchNo && !input.batchId) throw new Error(`Batch number is required for ${product.sku || product.name}`);
  if (product.hasSerialNo && !input.serialNoId) throw new Error(`Serial number is required for ${product.sku || product.name}`);
  if ((product.hasBatchNo || product.hasSerialNo) && actualQty.lt(0) && !input.batchId && !input.serialNoId) {
    throw new Error(`Serial/batch items cannot be issued without traceability for ${product.sku || product.name}`);
  }
  const before = await stockSnapshot(tx, input.productId, warehouse.id);
  const afterQty = before.quantity.plus(actualQty);
  if (afterQty.lt(0) && (!product.allowNegativeStock || product.hasBatchNo || product.hasSerialNo)) {
    throw new Error(`Insufficient stock for ${product.sku || product.name} in ${warehouse.name}`);
  }

  let valuationRate = new D(product.costPrice || 0);
  const inputRate = new D(input.rate || product.costPrice || 0);
  if (actualQty.gt(0)) {
    valuationRate = product.valuationMethod === 'MOVING_AVERAGE'
      ? await movingAverageRate(tx, input.productId, warehouse.id, actualQty, inputRate)
      : inputRate;
  } else if (product.valuationMethod === 'FIFO') {
    valuationRate = await fifoOutgoingRate(tx, input.productId, warehouse.id, actualQty);
  } else {
    const last = await tx.stockLedgerEntry.findFirst({
      where: { productId: input.productId, warehouseId: warehouse.id, isCancelled: false },
      orderBy: [{ postingDate: 'desc' }, { createdAt: 'desc' }],
    });
    valuationRate = product.valuationMethod === 'STANDARD' ? new D(product.costPrice || 0) : new D(last?.valuationRate || inputRate);
  }

  const valueDiff = actualQty.mul(valuationRate);
  const stockValue = afterQty.mul(valuationRate);
  const entry = await tx.stockLedgerEntry.create({
    data: {
      productId: input.productId,
      warehouseId: warehouse.id,
      postingDate: input.postingDate || new Date(),
      voucherType: input.voucherType,
      voucherId: input.voucherId,
      voucherNo: input.voucherNo,
      actualQty,
      qtyAfterTransaction: afterQty,
      incomingRate: actualQty.gt(0) ? inputRate : null,
      outgoingRate: actualQty.lt(0) ? valuationRate : null,
      valuationRate,
      stockValue,
      stockValueDifference: valueDiff,
      batchId: input.batchId,
      serialNoId: input.serialNoId,
      remarks: input.remarks,
    },
  });

  if (actualQty.gt(0) && product.valuationMethod === 'FIFO') {
    await tx.inventoryValuationLayer.create({
      data: {
        productId: input.productId,
        warehouseId: warehouse.id,
        sourceLedgerEntryId: entry.id,
        postingDate: input.postingDate || new Date(),
        originalQty: actualQty,
        remainingQty: actualQty,
        rate: inputRate,
      },
    });
  }
  if (actualQty.lt(0) && product.valuationMethod === 'FIFO') {
    await consumeFifoLayers(tx, input.productId, warehouse.id, actualQty);
  }

  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId: input.productId, warehouseId: warehouse.id } },
    update: { quantity: Number(afterQty.toString()) },
    create: { productId: input.productId, warehouseId: warehouse.id, quantity: Number(afterQty.toString()) },
  });
  if (input.batchId) {
    await tx.batch.update({ where: { id: input.batchId }, data: { quantity: { increment: actualQty } } });
  }
  if (input.serialNoId) {
    await tx.serialNumber.update({
      where: { id: input.serialNoId },
      data: { warehouseId: actualQty.gt(0) ? warehouse.id : null, status: actualQty.gt(0) ? 'AVAILABLE' : 'DELIVERED' },
    });
  }
  return entry;
}

export async function postStockTransfer(tx: Tx, input: {
  productId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: Prisma.Decimal.Value;
  rate?: Prisma.Decimal.Value;
  postingDate?: Date;
  voucherType: string;
  voucherId?: string;
  voucherNo: string;
  remarks?: string;
}) {
  await postStockLedger(tx, { ...input, warehouseId: input.fromWarehouseId, actualQty: new D(input.quantity).neg(), remarks: input.remarks || 'Material transfer out' });
  await postStockLedger(tx, { ...input, warehouseId: input.toWarehouseId, actualQty: input.quantity, remarks: input.remarks || 'Material transfer in' });
}
