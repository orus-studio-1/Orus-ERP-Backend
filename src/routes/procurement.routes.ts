import { Router } from 'express';
import {
  getPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrderStatus, deletePurchaseOrder,
  getPurchaseInvoices, createPurchaseInvoice, updatePurchaseInvoiceStatus, deletePurchaseInvoice,
} from '../controllers/procurement.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/purchase-orders').get(getPurchaseOrders).post(createPurchaseOrder);
router.route('/purchase-orders/:id').get(getPurchaseOrder).delete(deletePurchaseOrder);
router.put('/purchase-orders/:id/status', updatePurchaseOrderStatus);

router.route('/purchase-invoices').get(getPurchaseInvoices).post(createPurchaseInvoice);
router.put('/purchase-invoices/:id/status', updatePurchaseInvoiceStatus);
router.delete('/purchase-invoices/:id', deletePurchaseInvoice);

export default router;
