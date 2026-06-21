import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { success, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { AuthRequest } from '../middleware/auth';

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, firstName, lastName, phone, role } = req.body;
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return error(res, 'Email already registered', 400);

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashed, firstName, lastName, phone, role: role || 'EMPLOYEE' },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
    });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET!, {
      expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any,
    });

    return success(res, { user, token }, 'Registration successful', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return error(res, 'Invalid credentials', 401);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return error(res, 'Invalid credentials', 401);

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET!, {
      expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any,
    });

    const { password: _, ...userData } = user;
    return success(res, { user: userData, token }, 'Login successful');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getMe = async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, avatar: true, role: true, isActive: true, createdAt: true },
    });
    if (!user) return error(res, 'User not found', 404);
    return success(res, user);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateProfile = async (req: AuthRequest, res: Response) => {
  try {
    const { firstName, lastName, phone, avatar } = req.body;
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { firstName, lastName, phone, avatar },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, avatar: true, role: true },
    });
    return success(res, user, 'Profile updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const changePassword = async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return error(res, 'User not found', 404);

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return error(res, 'Current password is incorrect', 400);

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });
    return success(res, null, 'Password changed successfully');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getUsers = async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, users);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

