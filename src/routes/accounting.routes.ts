import { Router } from 'express';
import {
  getAccounts, getAccount, createAccount, updateAccount, deleteAccount,
  getJournalEntries, getJournalEntry, createJournalEntry, postJournalEntry, cancelJournalEntry, deleteJournalEntry,
  getFiscalYears, createFiscalYear,
  getTrialBalance,
} from '../controllers/accounting.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/accounts').get(getAccounts).post(createAccount);
router.route('/accounts/:id').get(getAccount).put(updateAccount).delete(deleteAccount);

router.route('/journal-entries').get(getJournalEntries).post(createJournalEntry);
router.route('/journal-entries/:id').get(getJournalEntry).delete(deleteJournalEntry);
router.put('/journal-entries/:id/post', postJournalEntry);
router.put('/journal-entries/:id/cancel', cancelJournalEntry);

router.route('/fiscal-years').get(getFiscalYears).post(createFiscalYear);

router.get('/reports/trial-balance', getTrialBalance);

export default router;
