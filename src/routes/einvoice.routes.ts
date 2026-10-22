import { Router } from 'express';
import {
  cancelEInvoice, checkEInvoiceRequirement, einvoiceReadiness, getCompanyGstProfile, updateCompanyGstProfile, createEInvoice, createRuleVersion, deleteEInvoice, einvoiceQr, einvoiceSellerGstins, exportEInvoices, failedEInvoices, getEInvoice,
  getEInvoiceSettings, importEInvoiceResult, listEInvoices, recordEInvoiceError, recordEInvoiceIrn, refreshEInvoice, setEInvoiceTurnover, unreportedEInvoices, updateEInvoice,
  updateEInvoiceConfig, verifyRuleVersion,
} from '../controllers/invoicingExtras/einvoice.controller';

// Mounted under the invoicing router (invoicing-extras.routes.ts), which already authenticates and gates the
// "einvoice" resource, so there is no gate here. Fixed paths come before /:id.
const router = Router();

router.get('/settings', getEInvoiceSettings);
router.get('/readiness', einvoiceReadiness);
router.route('/company-profile').get(getCompanyGstProfile).put(updateCompanyGstProfile);
router.put('/config', updateEInvoiceConfig);
router.post('/rule-versions', createRuleVersion);
router.post('/rule-versions/:id/verify', verifyRuleVersion);
router.put('/turnover', setEInvoiceTurnover);
router.get('/seller-gstins', einvoiceSellerGstins);
router.get('/check', checkEInvoiceRequirement);
router.get('/unreported', unreportedEInvoices);
router.get('/failed', failedEInvoices);
router.post('/export', exportEInvoices);
router.post('/import-result', importEInvoiceResult);

router.route('/').get(listEInvoices).post(createEInvoice);
router.route('/:id').get(getEInvoice).patch(updateEInvoice).delete(deleteEInvoice);
router.post('/:id/export', exportEInvoices);
router.post('/:id/refresh', refreshEInvoice);
router.post('/:id/record-irn', recordEInvoiceIrn);
router.post('/:id/record-error', recordEInvoiceError);
router.post('/:id/cancel', cancelEInvoice);
router.get('/:id/qr', einvoiceQr);

export default router;
