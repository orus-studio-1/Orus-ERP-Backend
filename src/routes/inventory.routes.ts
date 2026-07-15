import { Router } from 'express';
import {
  getProducts, getProduct, createProduct, updateProduct, deleteProduct,
  getCategories, createCategory, updateCategory, deleteCategory,
  getWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
  getStockMovements, createStockMovement,
  getUnits, createUnit, deleteUnit,
} from '../controllers/inventory.controller';
import { authenticate, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(requireModuleAccess('inventory'));

router.route('/products').get(getProducts).post(createProduct);
router.route('/products/:id').get(getProduct).put(updateProduct).delete(deleteProduct);

router.route('/categories').get(getCategories).post(createCategory);
router.route('/categories/:id').put(updateCategory).delete(deleteCategory);

router.route('/warehouses').get(getWarehouses).post(createWarehouse);
router.route('/warehouses/:id').put(updateWarehouse).delete(deleteWarehouse);

router.route('/stock-movements').get(getStockMovements).post(createStockMovement);

router.route('/units').get(getUnits).post(createUnit);
router.delete('/units/:id', deleteUnit);

export default router;
