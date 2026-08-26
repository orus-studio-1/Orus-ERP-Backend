import { Router } from 'express';
import {
  getProducts, getProduct, createProduct, updateProduct, deleteProduct,
  getCategories, createCategory, updateCategory, deleteCategory,
  getWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
  getStockMovements, createStockMovement,
  getUnits, createUnit, updateUnit, deleteUnit,
  getStockEntries, getStockEntry, createStockEntry, updateStockEntry, deleteStockEntry, updateStockEntryStatus,
  getPriceLists, createPriceList, updatePriceList, deletePriceList,
  getItemPrices, createItemPrice, updateItemPrice, deleteItemPrice,
  getPricingRules, createPricingRule, updatePricingRule, deletePricingRule,
  getStockBalanceReport, getStockLedgerReport, getProjectedStockReport,
  getReservedStockReport, getWarehouseValuationReport, getItemWiseSalesReport, getGrossProfitReport, getSlowMovingStockReport,
  createManualStockReservation, createManualSlowMovingStock,
  getProductAttributes, createProductAttribute, updateProductAttribute, deleteProductAttribute,
  getUomConversions, createUomConversion, updateUomConversion, deleteUomConversion,
  getBatches, createBatch, updateBatch, deleteBatch,
  getSerialNumbers, createSerialNumber, updateSerialNumber, deleteSerialNumber,
  amendStockEntry,
} from '../controllers/inventory.controller';
import {
  approveReconciliation, barcodeLookup, cancelReconciliation, createBatchGenealogy, createReconciliation,
  createTransferOrder, updateTransferOrder, deleteTransferOrder, inventoryReport, listReconciliations, listTransferOrders,
  materialRequestOperation, reconciliationTemplate, startReconciliation,
  submitReconciliation, traceability, transferOperation, uploadCounts, upsertCustomerItemCode, upsertWarehouseRule,
} from '../controllers/inventory/completion.controller';
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
router.route('/stock-entries/:id').get(getStockEntry).put(updateStockEntry).delete(deleteStockEntry);
router.patch('/stock-entries/:id/status', updateStockEntryStatus);
router.post('/stock-entries/:id/amend', amendStockEntry);

router.route('/price-lists').get(getPriceLists).post(createPriceList);
router.route('/price-lists/:id').put(updatePriceList).delete(deletePriceList);

router.route('/item-prices').get(getItemPrices).post(createItemPrice);
router.route('/item-prices/:id').put(updateItemPrice).delete(deleteItemPrice);

router.route('/pricing-rules').get(getPricingRules).post(createPricingRule);
router.route('/pricing-rules/:id').put(updatePricingRule).delete(deletePricingRule);

router.get('/reports/stock-balance', getStockBalanceReport);
router.get('/reports/stock-ledger', getStockLedgerReport);
router.get('/reports/projected-stock', getProjectedStockReport);
router.get('/reports/reserved-stock', getReservedStockReport);
router.get('/reports/warehouse-valuation', getWarehouseValuationReport);
router.get('/reports/item-wise-sales', getItemWiseSalesReport);
router.get('/reports/gross-profit', getGrossProfitReport);
router.get('/reports/slow-moving-stock', getSlowMovingStockReport);
router.post('/reports/reserved-stock/manual', createManualStockReservation);
router.post('/reports/slow-moving-stock/manual', createManualSlowMovingStock);

router.route('/units').get(getUnits).post(createUnit);
router.route('/units/:id').put(updateUnit).delete(deleteUnit);

router.route('/attributes').get(getProductAttributes).post(createProductAttribute);
router.route('/attributes/:id').put(updateProductAttribute).delete(deleteProductAttribute);

router.route('/uom-conversions').get(getUomConversions).post(createUomConversion);
router.route('/uom-conversions/:id').put(updateUomConversion).delete(deleteUomConversion);

router.route('/batches').get(getBatches).post(createBatch);
router.route('/batches/:id').put(updateBatch).delete(deleteBatch);

router.route('/serial-numbers').get(getSerialNumbers).post(createSerialNumber);
router.route('/serial-numbers/:id').put(updateSerialNumber).delete(deleteSerialNumber);


router.get('/barcode/:value', barcodeLookup);
router.put('/products/:productId/warehouse-rules', upsertWarehouseRule);
router.put('/products/:productId/customer-codes', upsertCustomerItemCode);
router.post('/batch-genealogy', createBatchGenealogy);
router.route('/reconciliations').get(listReconciliations).post(createReconciliation);
router.get('/reconciliations/:id/template', reconciliationTemplate);
router.post('/reconciliations/:id/start', startReconciliation);
router.post('/reconciliations/:id/counts', uploadCounts);
router.post('/reconciliations/:id/approve', approveReconciliation);
router.post('/reconciliations/:id/submit', submitReconciliation);
router.post('/reconciliations/:id/cancel', cancelReconciliation);
router.route('/transfer-orders').get(listTransferOrders).post(createTransferOrder);
router.route('/transfer-orders/:id').put(updateTransferOrder).delete(deleteTransferOrder);
for (const operation of ['submit', 'dispatch', 'receive', 'cancel']) router.post(`/transfer-orders/:id/${operation}`, (req, res) => { (req.params as any).operation = operation; return transferOperation(req, res); });
for (const operation of ['submit', 'cancel', 'issue', 'create-po', 'create-work-order']) router.post(`/material-requests/:id/${operation}`, (req, res) => { (req.params as any).operation = operation; return materialRequestOperation(req, res); });
router.get('/traceability/batches/:batchId', traceability);
router.get('/reports/advanced/:type', inventoryReport);

export default router;
