// Demo products, stock, tax rates and a fiscal year, so a sales order (and its delivery and invoice)
// can be created in a company that has none of this yet. For a LOCAL database only.
//
//   npx ts-node --transpile-only prisma/seed-erp-demo.ts
//   npx ts-node --transpile-only prisma/seed-erp-demo.ts --company some-slug   (default: orus-demo)
//
// It is safe to run again: units, categories, warehouses, tax templates, the fiscal year and products
// are matched by their name or code and left alone when they exist, and opening stock is posted once.
// Opening stock goes through the same postStockLedger the app uses, so stock levels and the ledger agree.
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { runWithTenant } from '../src/utils/tenant';
import { postStockLedger } from '../src/services/inventory/stockLedger.service';

const args = process.argv.slice(2);
const slug = args.includes('--company') ? args[args.indexOf('--company') + 1] : 'orus-demo';
const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`Refusing to seed: DATABASE_URL host is "${host || 'unknown'}", not localhost.`);
  process.exit(1);
}

const units = [['Nos', 'Nos'], ['Box', 'Box'], ['Day', 'Day']] as const;
const categories = [['ELEC', 'Electronics'], ['NET', 'Networking and Cables'], ['CONS', 'Consumables'], ['SRV', 'Services and Licences']] as const;
const taxes = [['GST18', 'GST 18%', 18, true], ['GST12', 'GST 12%', 12, false], ['GST5', 'GST 5%', 5, false]] as const;

// sku, name, type, category code, unit, cost, sale, tax %, hsn, opening qty
const products = [
  ['DEMO-SCAN-01', 'Barcode Scanner', 'PRODUCT', 'ELEC', 'Nos', 1800, 2500, 18, '8471', 120],
  ['DEMO-PRN-02', 'Thermal Receipt Printer', 'PRODUCT', 'ELEC', 'Nos', 6500, 8900, 18, '8443', 60],
  ['DEMO-POS-03', 'POS Terminal', 'PRODUCT', 'ELEC', 'Nos', 18000, 24500, 18, '8470', 25],
  ['DEMO-SW-04', 'Network Switch 24-port', 'PRODUCT', 'NET', 'Nos', 7200, 9800, 18, '8517', 40],
  ['DEMO-CAB-05', 'Cat6 Cable (305 m box)', 'PRODUCT', 'NET', 'Box', 3200, 4200, 18, '8544', 80],
  ['DEMO-PAP-06', 'Thermal Paper Roll (box of 50)', 'PRODUCT', 'CONS', 'Box', 900, 1300, 12, '4811', 300],
  ['DEMO-LBL-07', 'Barcode Label Roll', 'PRODUCT', 'CONS', 'Nos', 120, 180, 12, '4821', 500],
  ['DEMO-LIC-08', 'ERP User Licence (per user, yearly)', 'SERVICE', 'SRV', 'Nos', 0, 12000, 18, '9973', 0],
  ['DEMO-IMP-09', 'Implementation and Training (per day)', 'SERVICE', 'SRV', 'Day', 0, 15000, 18, '9983', 0],
  ['DEMO-SUP-10', 'Annual Support Contract', 'SERVICE', 'SRV', 'Nos', 0, 60000, 18, '9987', 0],
] as const;

async function main() {
  const company = await prisma.company.findUnique({ where: { slug } });
  if (!company) throw new Error(`Company "${slug}" not found`);
  const user = await prisma.user.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } });
  const branch = await prisma.branch.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } });
  const context = { tenantId: company.tenantId, companyId: company.id, branchId: branch?.id, userId: user?.id };
  const made: Record<string, number> = { units: 0, categories: 0, warehouses: 0, taxTemplates: 0, fiscalYears: 0, periods: 0, products: 0, openingStock: 0 };

  await runWithTenant(context, async () => {
    const unitId: Record<string, string> = {};
    for (const [name, symbol] of units) {
      let row = await prisma.unit.findFirst({ where: { name } });
      if (!row) { row = await prisma.unit.create({ data: { name, symbol } }); made.units++; }
      unitId[name] = row.id;
    }
    const categoryId: Record<string, string> = {};
    for (const [code, name] of categories) {
      let row = await prisma.category.findFirst({ where: { code } });
      if (!row) { row = await prisma.category.create({ data: { code, name } }); made.categories++; }
      categoryId[code] = row.id;
    }
    const warehouseId: Record<string, string> = {};
    for (const [code, name, isDefault] of [['MAIN', 'Main Warehouse', true], ['STORE', 'Store Room', false]] as const) {
      let row = await prisma.warehouse.findFirst({ where: { code } });
      if (!row) { row = await prisma.warehouse.create({ data: { code, name, isDefault, isActive: true, branchId: branch?.id } as any }); made.warehouses++; }
      warehouseId[code] = row.id;
    }
    const templateId: Record<number, string> = {};
    for (const [code, name, rate, isDefault] of taxes) {
      let row = await prisma.taxTemplate.findFirst({ where: { code } });
      if (!row) {
        row = await prisma.taxTemplate.create({ data: { code, name, isDefault, isActive: true, lines: { create: [{ label: name, rate, rowOrder: 1 }] } } as any });
        made.taxTemplates++;
      }
      templateId[rate] = row.id;
    }
    // Posting stock, deliveries and invoices to the ledger needs an open fiscal year with monthly periods.
    let fiscalYear = await prisma.fiscalYear.findFirst({ where: { name: 'FY 2026-27' }, include: { periods: true } });
    if (!fiscalYear) {
      fiscalYear = await prisma.fiscalYear.create({ data: { name: 'FY 2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isActive: true }, include: { periods: true } });
      made.fiscalYears++;
    }
    if (!fiscalYear.periods.length) {
      const months = Array.from({ length: 12 }, (_, i) => {
        const start = new Date(Date.UTC(2026, 3 + i, 1));
        const end = new Date(Date.UTC(2026, 4 + i, 0, 23, 59, 59, 999));
        return { fiscalYearId: fiscalYear!.id, name: start.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), startDate: start, endDate: end };
      });
      await prisma.period.createMany({ data: months as any });
      made.periods = months.length;
    }

    for (const [sku, name, type, category, unit, cost, sale, tax, hsn, qty] of products) {
      let product = await prisma.product.findFirst({ where: { sku } });
      if (!product) {
        product = await prisma.product.create({
          data: {
            sku, name, type, description: name, categoryId: categoryId[category], unitId: unitId[unit], costPrice: cost, salePrice: sale, taxRate: tax,
            hsnCode: hsn, defaultTaxTemplateId: templateId[tax], defaultWarehouseId: type === 'PRODUCT' ? warehouseId.MAIN : undefined,
            maintainStock: type === 'PRODUCT', reorderLevel: type === 'PRODUCT' ? 20 : 0, reorderQty: type === 'PRODUCT' ? 50 : 0, isActive: true,
          } as any,
        });
        made.products++;
      }
      if (type === 'PRODUCT' && qty > 0) {
        const posted = await prisma.stockLedgerEntry.count({ where: { productId: product.id, voucherType: 'OPENING_STOCK' } });
        if (!posted) {
          await prisma.$transaction(async (tx: any) => {
            await postStockLedger(tx, { productId: product!.id, warehouseId: warehouseId.MAIN, actualQty: qty, rate: cost, voucherType: 'OPENING_STOCK', voucherNo: 'OPEN-DEMO-001', remarks: 'Demo opening stock' });
            // a few units in the second warehouse too, for transfers
            if (sku === 'DEMO-SCAN-01') await postStockLedger(tx, { productId: product!.id, warehouseId: warehouseId.STORE, actualQty: 20, rate: cost, voucherType: 'OPENING_STOCK', voucherNo: 'OPEN-DEMO-002', remarks: 'Demo opening stock' });
          });
          made.openingStock++;
        }
      }
    }
  });

  console.log(`Demo ERP data for "${company.name}" (${company.slug}):`);
  console.table(made);
  console.log('Products: 7 goods with opening stock (Main Warehouse) and 3 services. Tax templates: GST 18%, 12%, 5%.');
  console.log('Now: Sales, Orders, New: pick a customer and add items such as "Barcode Scanner" (2500) or "POS Terminal" (24500).');
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => process.exit());
