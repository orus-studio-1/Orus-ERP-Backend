import { Router } from 'express';
import { createPayment, createPaymentEntry, deletePayment, getPayment, getPaymentEntries, getPaymentEntry, getPayments, updatePaymentEntry, updatePaymentEntryStatus } from '../controllers/invoices.controller';
import { authenticate, authorize, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('invoicing', () => 'payments'));

router.route('/entries').get(getPaymentEntries).post(authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER'), createPaymentEntry);
router.route('/entries/:id').get(getPaymentEntry).put(authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER'), updatePaymentEntry).patch(authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER'), updatePaymentEntry);
router.patch('/entries/:id/status', authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'), updatePaymentEntryStatus);
router.route('/').get(getPayments).post(createPayment);
router.route('/:id').get(getPayment).delete(deletePayment);

export default router;
