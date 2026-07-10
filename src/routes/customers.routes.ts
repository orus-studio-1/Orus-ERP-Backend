import { Router } from 'express';
import { getCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer, getCustomerInvoices, getCustomerOutstanding } from '../controllers/customers.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/').get(getCustomers).post(createCustomer);
router.get('/:id/invoices', getCustomerInvoices);
router.get('/:id/outstanding', getCustomerOutstanding);
router.route('/:id').get(getCustomer).put(updateCustomer).delete(deleteCustomer);

export default router;
