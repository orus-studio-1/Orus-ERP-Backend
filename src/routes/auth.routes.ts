import { Router } from 'express';
import { register, login, getMe, updateProfile, changePassword, getUsers } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', authenticate, getMe);
router.put('/profile', authenticate, updateProfile);
router.put('/change-password', authenticate, changePassword);
router.get('/users', authenticate, getUsers);

export default router;
