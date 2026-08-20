import { Router } from 'express';
import {
  register,
  login,
  logout,
  getMe,
  updateProfile,
  changePassword,
  getUsers,
  checkSlugAvailability,
  getWorkspaceInfo,
  logoutAll,
  refresh,
  forgotPassword,
  resetPassword,
  verifyLoginTwoFactor,
  enrollTwoFactor,
  enableTwoFactor,
  getSessions,
  revokeSession,
  switchCompany,
} from '../controllers/auth.controller';
import { authenticate, requirePermission } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'auth' });

router.get('/check-slug/:slug', checkSlugAvailability);
router.get('/workspace/:slug', getWorkspaceInfo);
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/login/2fa', authLimiter, verifyLoginTwoFactor);
router.post('/refresh', authLimiter, refresh);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);
router.post('/logout', authenticate, logout);
router.post('/logout-all', authenticate, logoutAll);
router.post('/2fa/enroll', authenticate, enrollTwoFactor);
router.post('/2fa/verify', authenticate, enableTwoFactor);
router.post('/switch-company', authenticate, switchCompany);
router.get('/sessions', authenticate, getSessions);
router.delete('/sessions/:id', authenticate, revokeSession);
router.get('/me', authenticate, getMe);
router.put('/profile', authenticate, updateProfile);
router.put('/change-password', authenticate, changePassword);
router.get('/users', authenticate, requirePermission('access', 'users', 'READ'), getUsers);

export default router;
