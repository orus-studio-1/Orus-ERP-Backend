import { Router } from 'express';
import {
  getLeads, getLead, createLead, updateLead, deleteLead, convertLead, previewLeadImport, importLeads, getLeadImports, getLeadImport,
  qualifyLead, markLeadLost,
  getContacts, getContact, createContact, updateContact, deleteContact,
  getOpportunities, getOpportunity, createOpportunity, updateOpportunity, deleteOpportunity, getPipeline, createOpportunityErpDocs,
  getActivities, getLeadActivities, createActivity, createLeadActivity, updateActivity, completeActivity, cancelActivity, deleteActivity,
  getOrganizations, getOrganization, createOrganization, updateOrganization, deleteOrganization,
  getCrmDashboard, getSavedViews, createSavedView, deleteSavedView,
  getAssignmentRules, createAssignmentRule, updateAssignmentRule, deleteAssignmentRule, testAssignmentRule,
} from '../controllers/crm.controller';
import { authenticate, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('crm'));

router.get('/dashboard', getCrmDashboard);

router.post('/leads/import/preview', previewLeadImport);
router.post('/leads/import', importLeads);
router.get('/leads/imports', getLeadImports);
router.get('/leads/imports/:id', getLeadImport);
router.route('/leads').get(getLeads).post(createLead);
router.post('/leads/:id/qualify', qualifyLead);
router.post('/leads/:id/mark-lost', markLeadLost);
router.post('/leads/:id/convert', convertLead);
router.route('/leads/:id/activities').get(getLeadActivities).post(createLeadActivity);
router.route('/leads/:id').get(getLead).put(updateLead).delete(deleteLead);

router.route('/assignment-rules').get(getAssignmentRules).post(createAssignmentRule);
router.post('/assignment-rules/test', testAssignmentRule);
router.route('/assignment-rules/:id').put(updateAssignmentRule).patch(updateAssignmentRule).delete(deleteAssignmentRule);

router.route('/organizations').get(getOrganizations).post(createOrganization);
router.route('/organizations/:id').get(getOrganization).put(updateOrganization).delete(deleteOrganization);

router.route('/contacts').get(getContacts).post(createContact);
router.route('/contacts/:id').get(getContact).put(updateContact).delete(deleteContact);

router.get('/opportunities/pipeline', getPipeline);
router.route('/opportunities').get(getOpportunities).post(createOpportunity);
router.post('/opportunities/:id/create-erp-docs', createOpportunityErpDocs);
router.route('/opportunities/:id').get(getOpportunity).put(updateOpportunity).patch(updateOpportunity).delete(deleteOpportunity);

router.route('/activities').get(getActivities).post(createActivity);
router.put('/activities/:id/complete', completeActivity);
router.put('/activities/:id/cancel', cancelActivity);
router.route('/activities/:id').put(updateActivity).delete(deleteActivity);

router.route('/saved-views').get(getSavedViews).post(createSavedView);
router.delete('/saved-views/:id', deleteSavedView);

export default router;
