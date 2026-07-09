import { Router } from 'express';
import {
  getSalesInvoices, getSalesInvoice, createSalesInvoice, updateInvoiceStatus, deleteSalesInvoice,
  getPayments, createPayment, deletePayment,
  getCustomerInvoices, getCustomerOutstandingSummary,
  searchProducts, createInvoiceFromSalesOrder, updateSalesInvoice,
  getAgingReport, getPayment,
} from '../controllers/invoicing.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/sales-invoices').get(getSalesInvoices).post(createSalesInvoice);
router.route('/sales-invoices/:id').get(getSalesInvoice).delete(deleteSalesInvoice);
router.put('/sales-invoices/:id/status', updateInvoiceStatus);
router.post('/invoices/from-sales-order/:salesOrderId', createInvoiceFromSalesOrder);
router.patch('/invoices/:id', updateSalesInvoice);

router.route('/payments').get(getPayments).post(createPayment);
router.get('/payments/:id', getPayment);
router.delete('/payments/:id', deletePayment);

router.route('/customers/:id/invoices').get(getCustomerInvoices);
router.route('/customers/:id/outstanding').get(getCustomerOutstandingSummary);
router.route('/products/search').get(searchProducts);

// Registering Aging Report Endpoint (Keep it above /invoices/:id)
router.get('/invoices/aging-report', getAgingReport);

export default router;
