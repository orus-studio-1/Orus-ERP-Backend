import { Router } from 'express';
import { createProduct, deleteProduct, getProduct, getProducts, searchProducts, updateProduct } from '../controllers/inventory.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/search', searchProducts);
router.route('/').get(getProducts).post(createProduct);
router.route('/:id').get(getProduct).patch(updateProduct).delete(deleteProduct);

export default router;
