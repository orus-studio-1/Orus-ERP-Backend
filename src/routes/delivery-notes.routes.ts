import { Router } from 'express';
import {
  createDeliveryNote,
  createDeliveryNoteFromSalesOrder,
  getDeliveryNote,
  getDeliveryNotes,
  updateDeliveryNoteStatus,
  updateDeliveryNote,
} from '../controllers/deliveryNotes.controller';
import { authenticate, authorize, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('invoicing', () => 'delivery-notes'));

router.post('/from-sales-order/:salesOrderId', authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'SALES_REP'), createDeliveryNoteFromSalesOrder);
router.route('/').get(getDeliveryNotes).post(authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'SALES_REP'), createDeliveryNote);
router.route('/:id').get(getDeliveryNote).put(authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'SALES_REP'), updateDeliveryNote).patch(authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'SALES_REP'), updateDeliveryNote);
router.patch('/:id/status', authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER'), updateDeliveryNoteStatus);

export default router;
