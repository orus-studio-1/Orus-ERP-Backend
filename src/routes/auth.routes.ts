import { Router } from 'express';
import {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  getUsers,
  checkSlugAvailability,
  getWorkspaceInfo,
} from '../controllers/auth.controller';
import { authenticate, requirePermission } from '../middleware/auth';

const router = Router();

router.get('/check-slug/:slug', checkSlugAvailability);
router.get('/workspace/:slug', getWorkspaceInfo);
router.post('/register', register);
router.post('/login', login);
router.get('/me', authenticate, getMe);
router.put('/profile', authenticate, updateProfile);
router.put('/change-password', authenticate, changePassword);
router.get('/users', authenticate, requirePermission('access', 'users', 'READ'), getUsers);

export default router;
