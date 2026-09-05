import { Router } from 'express';
import { authenticate, requireModuleAccess } from '../middleware/auth';
import * as m from '../controllers/manufacturing.controller';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('manufacturing'));

router.route('/boms').get(m.listBoms).post(m.createBom);
router.get('/boms/compare', m.compareBoms);
router.route('/boms/:id').get(m.getBom).patch(m.updateBom).delete(m.deleteBom);
router.post('/boms/:id/submit', m.submitBom);
router.post('/boms/:id/revise', m.reviseBom);
router.get('/boms/:id/explosion', m.getBomExplosion);
router.get('/boms/:id/cost', m.getBomCost);
router.get('/boms/:id/where-used', m.whereUsed);
router.post('/boms/:id/replace-item', m.replaceBomItem);

router.route('/routings').get(m.listRoutings).post(m.createRouting);
router.patch('/routings/:id', m.updateRouting);
router.post('/routings/:id/submit', m.submitRouting);

for (const resource of ['work-centers', 'machines', 'operations', 'downtime-reasons']) {
  router.get(`/${resource}`, (req, res) => { (req.params as any).resource = resource; return m.listMasters(req, res); });
  router.post(`/${resource}`, (req, res) => { (req.params as any).resource = resource; return m.createMaster(req, res); });
  router.patch(`/${resource}/:id`, (req, res) => { (req.params as any).resource = resource; return m.updateMaster(req, res); });
}
router.get('/work-centers/:id/capacity', m.workCenterCapacity);
router.post('/machines/:id/status', m.machineStatus);

router.route('/work-orders').get(m.listWorkOrders).post(m.createWorkOrder);
router.route('/work-orders/:id').get(m.getWorkOrder).patch(m.updateWorkOrder).delete(m.deleteWorkOrder);
router.post('/work-orders/:id/submit', m.submitWorkOrder);
router.post('/work-orders/:id/start', m.startWorkOrder);
router.post('/work-orders/:id/hold', m.holdWorkOrder);
router.post('/work-orders/:id/resume', m.startWorkOrder);
router.post('/work-orders/:id/issue-material', m.issueMaterial);
router.post('/work-orders/:id/return-material', m.returnMaterial);
router.post('/work-orders/:id/receive', m.receiveProduction);
router.post('/work-orders/:id/scrap', m.scrapProduction);
router.post('/work-orders/:id/close', m.closeWorkOrder);
router.post('/work-orders/:id/cancel', m.cancelWorkOrder);
router.get('/work-orders/:id/material-availability', m.workOrderAvailability);
router.get('/work-orders/:id/cost-sheet', m.workOrderCostSheet);
router.get('/work-orders/:id/traceability', m.workOrderTraceability);

router.get('/job-cards', m.listJobCards);
router.get('/job-cards/my-queue', m.myJobCards);
for (const action of ['start', 'pause', 'resume', 'complete', 'first-piece-approve']) router.post(`/job-cards/:id/${action}`, (req, res) => { (req.params as any).action = action; return m.jobCardAction(req, res); });
router.post('/job-cards/:id/log-production', m.logProduction);
router.post('/job-cards/:id/downtime', m.logDowntime);
router.get('/shopfloor/dashboard', m.shopfloorDashboard);
router.post('/shopfloor/scan', m.shopfloorScan);
router.get('/reports/:type', m.manufacturingReport);

export default router;
