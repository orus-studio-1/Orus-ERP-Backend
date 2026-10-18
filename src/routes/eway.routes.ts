import { Router } from 'express';
import {
  cancelEwayBill, checkEwayRequirement, createEwayBill, deleteEwayBill, ewayBillPdf, ewayDispatchGstins, expiringEwayBills, exportEwayBills, extendEwayBill,
  getEwayBill, getEwayConfig, listEwayBills, pendingEwayBills, recordEwayNumber, updateEwayBill, updateEwayConfig, updateEwayVehicle,
} from '../controllers/invoicingExtras/eway.controller';

// Mounted under the invoicing router (invoicing-extras.routes.ts), which already authenticates and gates the
// "eway-bills" resource, so there is no gate here. Fixed paths come before /:id.
const router = Router();

router.get('/config', getEwayConfig);
router.put('/config', updateEwayConfig);
router.get('/dispatch-gstins', ewayDispatchGstins);
router.get('/check', checkEwayRequirement);
router.get('/pending', pendingEwayBills);
router.get('/expiring', expiringEwayBills);
router.post('/export', exportEwayBills);

router.route('/').get(listEwayBills).post(createEwayBill);
router.route('/:id').get(getEwayBill).patch(updateEwayBill).delete(deleteEwayBill);
router.post('/:id/export', exportEwayBills);
router.post('/:id/record-number', recordEwayNumber);
router.post('/:id/cancel', cancelEwayBill);
router.post('/:id/vehicle', updateEwayVehicle);
router.post('/:id/extend', extendEwayBill);
router.get('/:id/pdf', ewayBillPdf);

export default router;
