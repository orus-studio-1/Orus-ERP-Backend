import { Router } from 'express';
import {
  getProducts, getProduct, createProduct, updateProduct, deleteProduct,
  getCategories, createCategory, updateCategory, deleteCategory,
  getWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
  getStockMovements, createStockMovement,
  getUnits, createUnit, deleteUnit,
  getStockEntries, getStockEntry, createStockEntry, updateStockEntryStatus,
  getPriceLists, createPriceList, getItemPrices, createItemPrice, getPricingRules, createPricingRule,
  getStockBalanceReport, getStockLedgerReport, getProjectedStockReport,
  getReservedStockReport, getWarehouseValuationReport, getItemWiseSalesReport, getGrossProfitReport, getSlowMovingStockReport,
  getProductAttributes, createProductAttribute, createUomConversion, getBatches, createBatch, getSerialNumbers, createSerialNumber,
} from '../controllers/inventory.controller';
import { authenticate, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('inventory'));

router.route('/products').get(getProducts).post(createProduct);
router.route('/products/:id').get(getProduct).put(updateProduct).delete(deleteProduct);

router.route('/categories').get(getCategories).post(createCategory);
router.route('/categories/:id').put(updateCategory).delete(deleteCategory);

router.route('/warehouses').get(getWarehouses).post(createWarehouse);
router.route('/warehouses/:id').put(updateWarehouse).delete(deleteWarehouse);

router.route('/stock-movements').get(getStockMovements).post(createStockMovement);

router.route('/stock-entries').get(getStockEntries).post(createStockEntry);
router.route('/stock-entries/:id').get(getStockEntry);
router.patch('/stock-entries/:id/status', updateStockEntryStatus);

router.route('/price-lists').get(getPriceLists).post(createPriceList);
router.route('/item-prices').get(getItemPrices).post(createItemPrice);
router.route('/pricing-rules').get(getPricingRules).post(createPricingRule);

router.get('/reports/stock-balance', getStockBalanceReport);
router.get('/reports/stock-ledger', getStockLedgerReport);
router.get('/reports/projected-stock', getProjectedStockReport);
router.get('/reports/reserved-stock', getReservedStockReport);
router.get('/reports/warehouse-valuation', getWarehouseValuationReport);
router.get('/reports/item-wise-sales', getItemWiseSalesReport);
router.get('/reports/gross-profit', getGrossProfitReport);
router.get('/reports/slow-moving-stock', getSlowMovingStockReport);

router.route('/units').get(getUnits).post(createUnit);
router.delete('/units/:id', deleteUnit);

router.route('/attributes').get(getProductAttributes).post(createProductAttribute);
router.post('/uom-conversions', createUomConversion);
router.route('/batches').get(getBatches).post(createBatch);
router.route('/serial-numbers').get(getSerialNumbers).post(createSerialNumber);

export default router;
