import { Router } from 'express';
import {
  getLeads, getLead, createLead, updateLead, deleteLead, convertLead,
  getContacts, createContact, updateContact, deleteContact,
  getOpportunities, createOpportunity, updateOpportunity, deleteOpportunity,
  getActivities, createActivity, updateActivity, deleteActivity,
} from '../controllers/crm.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/leads').get(getLeads).post(createLead);
router.route('/leads/:id').get(getLead).put(updateLead).delete(deleteLead);
router.post('/leads/:id/convert', convertLead);

router.route('/contacts').get(getContacts).post(createContact);
router.route('/contacts/:id').put(updateContact).delete(deleteContact);

router.route('/opportunities').get(getOpportunities).post(createOpportunity);
router.route('/opportunities/:id').put(updateOpportunity).delete(deleteOpportunity);

router.route('/activities').get(getActivities).post(createActivity);
router.route('/activities/:id').put(updateActivity).delete(deleteActivity);

export default router;
