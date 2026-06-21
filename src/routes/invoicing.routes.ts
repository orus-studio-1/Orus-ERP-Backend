import { Router } from 'express';
import {
  getSalesInvoices, getSalesInvoice, createSalesInvoice, updateInvoiceStatus, deleteSalesInvoice,
  getPayments, createPayment, deletePayment,
} from '../controllers/invoicing.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/sales-invoices').get(getSalesInvoices).post(createSalesInvoice);
router.route('/sales-invoices/:id').get(getSalesInvoice).delete(deleteSalesInvoice);
router.put('/sales-invoices/:id/status', updateInvoiceStatus);

router.route('/payments').get(getPayments).post(createPayment);
router.delete('/payments/:id', deletePayment);

export default router;
