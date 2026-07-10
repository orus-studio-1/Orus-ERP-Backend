import { Router } from 'express';
import { convertQuotationToOrder } from '../controllers/sales.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.post('/from-quotation/:id', convertQuotationToOrder);

export default router;
