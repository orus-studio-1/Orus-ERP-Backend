import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { success, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { AuthRequest } from '../middleware/auth';
import { computeEffectiveAccess, ensureCompanyDefaultRoles } from '../utils/accessControl';
import { generateEmployeeId } from '../utils/generate';
import { passwordValidationMessage } from '../utils/password';

async function buildAuthPayload(user: any) {
  const access = await computeEffectiveAccess(user.id);
  const token = jwt.sign(
    { id: user.id, email: user.email, companyId: user.companyId, tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET!,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '1h') as any }
  );
  const { password: _, ...userData } = user;
  return {
    user: { ...userData, access },
    token,
  };
}

export const register = async (req: Request, res: Response) => {
  try {
    const { password, firstName, lastName, phone, companyName, companyPhone, country, currency } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return error(res, 'Email is required', 400);
    const passwordError = passwordValidationMessage(password);
    if (passwordError) return error(res, passwordError, 400);
    if (!firstName || !lastName) return error(res, 'First name and last name are required', 400);
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return error(res, 'Email already registered', 400);
    if (!companyName) return error(res, 'Company name is required', 400);

    const hashed = await bcrypt.hash(password, 10);
    const employeeId = await generateEmployeeId();
    const user = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: { name: companyName, email, phone: companyPhone || phone, country, currency: currency || 'USD' },
      });
      const createdUser = await tx.user.create({
        data: { email, password: hashed, firstName, lastName, phone, role: 'SUPER_ADMIN', companyId: company.id },
      });
      await tx.company.update({ where: { id: company.id }, data: { ownerId: createdUser.id } });
      await tx.employee.create({
        data: {
          employeeId,
          userId: createdUser.id,
          hireDate: new Date(),
          salary: 0,
          salaryType: 'MONTHLY',
          status: 'ACTIVE',
          companyEmail: email,
        },
      }).catch(() => null);
      await tx.accessAuditLog.create({
        data: {
          companyId: company.id,
          actorId: createdUser.id,
          targetUserId: createdUser.id,
          action: 'COMPANY_REGISTER',
          message: `Created company ${company.name} and assigned Super Admin`,
        },
      });
      return tx.user.findUnique({
        where: { id: createdUser.id },
        include: { company: true },
      });
    });
    if (!user) return error(res, 'Unable to create account', 500);

    const roles = await ensureCompanyDefaultRoles(user.companyId!);
    await prisma.userAccessRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: roles.SUPER_ADMIN.id } },
      update: {},
      create: { userId: user.id, roleId: roles.SUPER_ADMIN.id, assignedById: user.id },
    });
    await prisma.accessAuditLog.create({
      data: {
        companyId: user.companyId,
        actorId: user.id,
        targetUserId: user.id,
        action: 'SUPER_ADMIN_ACCESS_BOOTSTRAP',
        message: 'Assigned Super Admin default access role',
      },
    }).catch(() => null);

    return success(res, await buildAuthPayload(user), 'Company and Super Admin account created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    // Older accounts may have been stored before email normalization was added.
    const user = await prisma.user.findFirst({ where: { email: { equals: normalizedEmail, mode: 'insensitive' } } });
    if (!user || !user.isActive) return error(res, 'Invalid credentials', 401);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return error(res, 'Invalid credentials', 401);
    if (user.companyId && ['SUPER_ADMIN', 'ADMIN'].includes(user.role)) {
      const roles = await ensureCompanyDefaultRoles(user.companyId);
      const accessRole = roles[user.role];
      if (accessRole) await prisma.userAccessRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: accessRole.id } },
        update: {},
        create: { userId: user.id, roleId: accessRole.id, assignedById: user.id },
      });
    }

    return success(res, await buildAuthPayload(user), 'Login successful');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getMe = async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, avatar: true, role: true, companyId: true, company: true, isActive: true, createdAt: true },
    });
    if (!user) return error(res, 'User not found', 404);
    return success(res, { ...user, access: req.access });
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
    const passwordError = passwordValidationMessage(newPassword);
    if (passwordError) return error(res, passwordError, 400);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return error(res, 'User not found', 404);

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return error(res, 'Current password is incorrect', 400);

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { password: hashed, tokenVersion: { increment: 1 } } });
    return success(res, null, 'Password changed successfully');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const logout = async (req: AuthRequest, res: Response) => {
  try {
    await prisma.user.update({ where: { id: req.user!.id }, data: { tokenVersion: { increment: 1 } } });
    return success(res, null, 'Logged out successfully');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getUsers = async (req: Request, res: Response) => {
  try {
    const companyId = (req as AuthRequest).user?.companyId;
    const users = await prisma.user.findMany({
      where: companyId ? { companyId } : undefined,
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true, companyId: true, isActive: true, createdAt: true,
        accessRoles: { include: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, users);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
