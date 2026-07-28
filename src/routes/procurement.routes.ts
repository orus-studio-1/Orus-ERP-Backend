import { Router } from 'express';
import {
  addSupplierCommunication,
  compareSupplierQuotations,
  createBlanketPurchaseOrder,
  createLandedCostVoucher,
  createMaterialRequest,
  createMaterialRequestsFromReorder,
  createPaymentTerms,
  createPurchaseInvoice,
  createPurchaseOrder,
  createPurchaseOrderFromSupplierQuotation,
  createPurchaseReceipt,
  createPurchaseReceiptFromPurchaseOrder,
  createQualityInspection,
  createRfq,
  createRfqFromMaterialRequest,
  createSupplierItem,
  createSupplierPayment,
  createSupplierQuotation,
  deletePurchaseInvoice,
  deletePurchaseOrder,
  getBlanketPurchaseOrders,
  getBuyingSettings,
  getLandedCostVouchers,
  getMaterialRequests,
  getPaymentTerms,
  getProcurementDashboard,
  getProcurementTracker,
  getPurchaseInvoices,
  getPurchaseOrder,
  getPurchaseOrders,
  getPurchaseReceipts,
  getQualityInspections,
  getRfqs,
  getSupplierItems,
  getSupplierCommunications,
  getSupplierPayments,
  getSupplierQuotations,
  updateBuyingSettings,
  updateLandedCostVoucherStatus,
  updateMaterialRequestStatus,
  updatePurchaseInvoiceStatus,
  updatePurchaseOrderStatus,
  updatePurchaseReceiptStatus,
  updateRfqStatus,
  updateSupplierPaymentStatus,
} from '../controllers/procurement.controller';
import { authenticate, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('procurement'));

router.get('/dashboard', getProcurementDashboard);
router.get('/tracker', getProcurementTracker);

router.route('/settings').get(getBuyingSettings).put(updateBuyingSettings).patch(updateBuyingSettings);
router.route('/payment-terms').get(getPaymentTerms).post(createPaymentTerms);
router.route('/supplier-items').get(getSupplierItems).post(createSupplierItem);
router.route('/communications').get(getSupplierCommunications).post(addSupplierCommunication);

router.route('/material-requests').get(getMaterialRequests).post(createMaterialRequest);
router.post('/material-requests/from-reorder', createMaterialRequestsFromReorder);
router.patch('/material-requests/:id/status', updateMaterialRequestStatus);
router.post('/material-requests/:id/rfq', createRfqFromMaterialRequest);

router.route('/rfqs').get(getRfqs).post(createRfq);
router.patch('/rfqs/:id/status', updateRfqStatus);
router.get('/rfqs/:rfqId/compare', compareSupplierQuotations);

router.route('/supplier-quotations').get(getSupplierQuotations).post(createSupplierQuotation);
router.post('/supplier-quotations/:id/purchase-order', createPurchaseOrderFromSupplierQuotation);

router.route('/blanket-purchase-orders').get(getBlanketPurchaseOrders).post(createBlanketPurchaseOrder);

router.route('/purchase-orders').get(getPurchaseOrders).post(createPurchaseOrder);
router.route('/purchase-orders/:id').get(getPurchaseOrder).delete(deletePurchaseOrder);
router.put('/purchase-orders/:id/status', updatePurchaseOrderStatus);
router.patch('/purchase-orders/:id/status', updatePurchaseOrderStatus);
router.post('/purchase-orders/:id/receipt', createPurchaseReceiptFromPurchaseOrder);

router.route('/purchase-receipts').get(getPurchaseReceipts).post(createPurchaseReceipt);
router.patch('/purchase-receipts/:id/status', updatePurchaseReceiptStatus);

router.route('/quality-inspections').get(getQualityInspections).post(createQualityInspection);

router.route('/landed-cost-vouchers').get(getLandedCostVouchers).post(createLandedCostVoucher);
router.patch('/landed-cost-vouchers/:id/status', updateLandedCostVoucherStatus);

router.route('/purchase-invoices').get(getPurchaseInvoices).post(createPurchaseInvoice);
router.put('/purchase-invoices/:id/status', updatePurchaseInvoiceStatus);
router.patch('/purchase-invoices/:id/status', updatePurchaseInvoiceStatus);
router.delete('/purchase-invoices/:id', deletePurchaseInvoice);

router.route('/supplier-payments').get(getSupplierPayments).post(createSupplierPayment);
router.patch('/supplier-payments/:id/status', updateSupplierPaymentStatus);

export default router;
