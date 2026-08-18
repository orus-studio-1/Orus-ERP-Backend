import { Router } from 'express';
import { register, login, logout, getMe, updateProfile, changePassword, getUsers } from '../controllers/auth.controller';
import { authenticate, requirePermission } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'auth' });
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, getMe);
router.put('/profile', authenticate, updateProfile);
router.put('/change-password', authenticate, changePassword);
router.get('/users', authenticate, requirePermission('access', 'users', 'READ'), getUsers);

export default router;
