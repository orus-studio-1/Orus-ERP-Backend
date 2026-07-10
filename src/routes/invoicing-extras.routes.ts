import { Router } from 'express';
import {
  createCreditNote,
  createPrintFormat,
  createSubscription,
  createTaxTemplate,
  getCreditNote,
  getCreditNotes,
  getLedgerEntries,
  getOutstandingInvoices,
  getPrintFormats,
  getRevenueByCustomer,
  getRevenueByItem,
  getRevenueByPeriod,
  getSubscriptions,
  getTaxTemplates,
  getAuditLogs,
  updateCreditNoteStatus,
  updateTaxTemplate,
  runDueSubscriptions,
} from '../controllers/invoicingExtras.controller';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/tax-templates').get(getTaxTemplates).post(createTaxTemplate);
router.patch('/tax-templates/:id', updateTaxTemplate);

router.route('/credit-notes').get(getCreditNotes).post(createCreditNote);
router.get('/credit-notes/:id', getCreditNote);
router.patch('/credit-notes/:id/status', updateCreditNoteStatus);

router.get('/ledger', getLedgerEntries);

router.route('/print-formats').get(getPrintFormats).post(createPrintFormat);

router.route('/subscriptions').get(getSubscriptions).post(createSubscription);
router.post('/subscriptions/run-due', authorize('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'), runDueSubscriptions);

router.get('/audit-logs', getAuditLogs);

router.get('/reports/outstanding', getOutstandingInvoices);
router.get('/reports/revenue-by-customer', getRevenueByCustomer);
router.get('/reports/revenue-by-item', getRevenueByItem);
router.get('/reports/revenue-by-period', getRevenueByPeriod);

export default router;
