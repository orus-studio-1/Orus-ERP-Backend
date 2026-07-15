import { Router } from 'express';
import {
  getQuotations, getQuotation, createQuotation, updateQuotation, deleteQuotation, convertQuotationToOrder,
  getSalesOrders, getSalesOrder, createSalesOrder, updateSalesOrderStatus, deleteSalesOrder,
  updateQuotationStatus,updateSalesOrder
} from '../controllers/sales.controller';
import { authenticate, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('sales'));

router.route('/quotations').get(getQuotations).post(createQuotation);
router.route('/quotations/:id').get(getQuotation).put(updateQuotation).delete(deleteQuotation);
router.post('/quotations/:id/convert', convertQuotationToOrder);

router.route('/orders').get(getSalesOrders).post(createSalesOrder);
router.route('/orders/:id').get(getSalesOrder).delete(deleteSalesOrder);
router.put('/orders/:id/status', updateSalesOrderStatus);

router.put('/sales-orders/:id', updateSalesOrder);
router.route('/quotations/:id/status').patch(updateQuotationStatus);

export default router;
