import { Request, Response } from 'express';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import prisma from '../lib/prisma';
import { success, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { AuthRequest } from '../middleware/auth';
import { computeEffectiveAccess, ensureCompanyDefaultRoles } from '../utils/accessControl';
import { generateEmployeeId } from '../utils/generate';
import { validateSlug, slugify } from '../utils/slug';
import { passwordValidationMessage } from '../utils/password';

const REFRESH_COOKIE = 'orus_refresh';
const REFRESH_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30);
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(48).toString('base64url');
const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/api', maxAge: REFRESH_DAYS * 86400000 };

async function verifyPassword(hash: string, password: string) {
  return hash.startsWith('$argon2') ? argon2.verify(hash, password) : bcrypt.compare(password, hash);
}
async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
async function contextFor(userId: string, companyIdOrSlug?: string) {
  let targetCompanyId = companyIdOrSlug;
  if (companyIdOrSlug) {
    const slugMatch = await prisma.company.findFirst({
      where: { OR: [{ id: companyIdOrSlug }, { slug: companyIdOrSlug.toLowerCase() }] },
      select: { id: true },
    });
    if (slugMatch) targetCompanyId = slugMatch.id;
  }

  if (targetCompanyId) {
    const membership = await prisma.companyMembership.findFirst({
      where: { userId, isActive: true, companyId: targetCompanyId },
    });
    if (membership) return { tenantId: membership.tenantId, companyId: membership.companyId, branchId: membership.defaultBranchId };
  }

  const firstMembership = await prisma.companyMembership.findFirst({
    where: { userId, isActive: true },
  });
  if (firstMembership) return { tenantId: firstMembership.tenantId, companyId: firstMembership.companyId, branchId: firstMembership.defaultBranchId };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { companyId: true, company: { select: { tenantId: true } } },
  });
  if (user?.companyId) {
    return { tenantId: user.company?.tenantId || null, companyId: user.companyId, branchId: null };
  }
  return { tenantId: null, companyId: null, branchId: null };
}
async function makeAccessToken(user: any, context: any, twoFactorVerified = false) {
  const company = context.companyId ? await prisma.company.findUnique({ where: { id: context.companyId }, select: { slug: true } }) : null;
  return jwt.sign({ sub: user.id, id: user.id, email: user.email, tenantId: context.tenantId, companyId: context.companyId, companySlug: company?.slug || null, branchId: context.branchId, tokenVersion: user.tokenVersion, twoFactorVerified }, process.env.JWT_SECRET!, { expiresIn: (process.env.JWT_ACCESS_TTL || '15m') as any });
}
async function makePayload(user: any, context: any, twoFactorVerified = false) {
  const token = await makeAccessToken(user, context, twoFactorVerified);
  const access = await computeEffectiveAccess(user.id);
  const { password, twoFactorSecret, ...safe } = user;

  const memberships = await prisma.companyMembership.findMany({
    where: { userId: user.id, isActive: true },
    include: { company: { select: { id: true, name: true, slug: true, logo: true, currency: true } } },
  });
  const accessibleCompanies = memberships.map((m) => m.company).filter(Boolean);

  const activeCompany = context.companyId
    ? accessibleCompanies.find((c) => c.id === context.companyId) ||
      (await prisma.company.findUnique({ where: { id: context.companyId }, select: { id: true, name: true, slug: true, logo: true, currency: true } }))
    : null;

  return {
    user: { ...safe, access, company: activeCompany || safe.company, accessibleCompanies },
    accessToken: token,
    token,
    expiresIn: 900,
    activeContext: {
      ...context,
      companySlug: activeCompany?.slug || null,
      accessibleCompanies,
    },
  };
}
async function makeRefresh(req: Request, userId: string, context: any, familyId = crypto.randomUUID(), parentHash?: string) {
  const raw = randomToken();
  await prisma.refreshSession.create({ data: { tenantId: context.tenantId || undefined, userId, familyId, tokenHash: sha256(raw), parentHash, companyId: context.companyId, branchId: context.branchId, userAgent: req.get('user-agent'), ip: ipOf(req), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400000) } });
  return raw;
}
const setRefresh = (res: Response, raw: string) => res.cookie(REFRESH_COOKIE, raw, cookieOptions);

export const register = async (req: Request, res: Response) => {
  try {
    const { password, firstName, lastName, phone, companyName, companyPhone, country, currency, slug } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    const invalid = passwordValidationMessage(password);
    if (!email || invalid || !firstName || !lastName || !companyName) return error(res, invalid || 'Email, name and company are required', 400, undefined, 'VALIDATION_ERROR');
    if (await prisma.user.findUnique({ where: { email } })) return error(res, 'Email already registered', 409, undefined, 'EMAIL_EXISTS');
    const slugValidation = validateSlug(slug || companyName);
    if (!slugValidation.valid) return error(res, slugValidation.error || 'Invalid workspace URL slug', 400, undefined, 'VALIDATION_ERROR');
    const finalSlug = slugValidation.slug!;
    if (await prisma.company.findUnique({ where: { slug: finalSlug } })) return error(res, 'Workspace URL is already taken. Please choose another.', 409, undefined, 'SLUG_EXISTS');
    const created = await prisma.$transaction(async (tx: any) => {
      const tenant = await tx.tenant.create({ data: { name: companyName, slug: finalSlug, baseCurrency: currency || 'INR' } });
      const company = await tx.company.create({ data: { tenantId: tenant.id, name: companyName, slug: finalSlug, legalName: companyName, email, phone: companyPhone || phone, country, currency: currency || 'INR' } });
      const branch = await tx.branch.create({ data: { tenantId: tenant.id, companyId: company.id, code: 'MAIN', name: 'Main Branch' } });
      const user = await tx.user.create({ data: { email, password: await hashPassword(password), firstName, lastName, phone, role: 'SUPER_ADMIN', companyId: company.id, passwordChangedAt: new Date() } });
      await tx.company.update({ where: { id: company.id }, data: { ownerId: user.id } });
      await tx.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, isOwner: true } });
      await tx.companyMembership.create({ data: { tenantId: tenant.id, companyId: company.id, userId: user.id, defaultBranchId: branch.id } });
      return { tenant, company, branch, user: await tx.user.findUnique({ where: { id: user.id }, include: { company: true } }) };
    });
    await prisma.employee.create({ data: { employeeId: await generateEmployeeId(), userId: created.user.id, hireDate: new Date(), salary: 0, salaryType: 'MONTHLY', status: 'ACTIVE', companyEmail: email } }).catch(() => null);
    const roles = await ensureCompanyDefaultRoles(created.company.id);
    await prisma.userAccessRole.upsert({ where: { userId_roleId: { userId: created.user.id, roleId: roles.SUPER_ADMIN.id } }, update: {}, create: { userId: created.user.id, roleId: roles.SUPER_ADMIN.id, assignedById: created.user.id } });
    const context = { tenantId: created.tenant.id, companyId: created.company.id, branchId: created.branch.id };
    setRefresh(res, await makeRefresh(req, created.user.id, context));
    return success(res, await makePayload(created.user, context), 'Tenant and administrator created', 201);
  } catch (e: any) { return handlePrismaError(res, e); }
};

export const login = async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const ip = ipOf(req);
    if (await prisma.loginAttempt.count({ where: { ip, success: false, createdAt: { gte: new Date(Date.now() - 15 * 60000) } } }) >= 25) return error(res, 'Too many failed attempts', 429, undefined, 'AUTH_LOCKED');
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      include: { company: true },
    });
    const valid = user && user.isActive && (!user.lockedUntil || user.lockedUntil <= new Date()) && await verifyPassword(user.password, String(req.body.password || ''));
    await prisma.loginAttempt.create({ data: { email, ip, success: Boolean(valid) } });
    if (!user || !valid) {
      if (user) { const count = user.failedLoginCount + 1; const mins = count >= 5 ? Math.min(60, 2 ** (count - 5)) : 0; await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: count, lockedUntil: mins ? new Date(Date.now() + mins * 60000) : null } }); }
      return error(res, 'Invalid credentials or account temporarily locked', 401, undefined, 'AUTH_INVALID');
    }
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, ...(!user.password.startsWith('$argon2') ? { password: await hashPassword(req.body.password), passwordChangedAt: new Date() } : {}) } });
    if (user.twoFactorEnabled) return success(res, { requiresTwoFactor: true, challenge: jwt.sign({ sub: user.id, purpose: '2fa-login' }, process.env.JWT_SECRET!, { expiresIn: '5m' }) }, 'Two-factor verification required');

    const requestedSlug = String(req.headers['x-tenant-slug'] || req.body.slug || req.body.companySlug || '').trim();
    const targetIdentifier = req.body.companyId || requestedSlug || undefined;
    const context = await contextFor(user.id, targetIdentifier);

    if (!context.companyId) return error(res, 'No active company membership found for your account', 403, undefined, 'COMPANY_REQUIRED');
    if (context.companyId) {
      await ensureCompanyDefaultRoles(context.companyId).catch(() => null);
    }

    setRefresh(res, await makeRefresh(req, user.id, context));
    return success(res, await makePayload(user, context), 'Login successful');
  } catch (e: any) { return handlePrismaError(res, e); }
};

export const checkSlugAvailability = async (req: Request, res: Response) => {
  try {
    const rawSlug = String(req.params.slug || req.query.slug || '').trim();
    const validation = validateSlug(rawSlug);
    if (!validation.valid) {
      return error(res, validation.error || 'Invalid workspace slug', 400);
    }

    const existing = await prisma.company.findUnique({
      where: { slug: validation.slug },
      select: { id: true, slug: true },
    });

    if (existing) {
      return error(res, 'Workspace URL is already taken', 409);
    }

    return success(res, { available: true, slug: validation.slug }, 'Workspace URL is available');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getWorkspaceInfo = async (req: Request, res: Response) => {
  try {
    const rawSlug = String(req.params.slug || '').trim().toLowerCase();
    if (!rawSlug) return error(res, 'Workspace slug is required', 400);

    const company = await prisma.company.findUnique({
      where: { slug: slugify(rawSlug) },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        currency: true,
        createdAt: true,
      },
    });

    if (!company) {
      return error(res, 'Workspace not found', 404);
    }

    return success(res, company, 'Workspace details');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const verifyLoginTwoFactor = async (req: Request, res: Response) => {
  try {
    const decoded: any = jwt.verify(req.body.challenge, process.env.JWT_SECRET!);
    const user = decoded.purpose === '2fa-login' ? await prisma.user.findUnique({ where: { id: decoded.sub } }) : null;
    if (!user?.twoFactorSecret || !(await verifyOtp({ secret: user.twoFactorSecret, token: String(req.body.code || '') })).valid) return error(res, 'Invalid verification code', 401, undefined, 'TWO_FACTOR_INVALID');
    const context = await contextFor(user.id, req.body.companyId);
    setRefresh(res, await makeRefresh(req, user.id, context));
    return success(res, await makePayload(user, context, true), 'Login successful');
  } catch { return error(res, 'Invalid or expired challenge', 401, undefined, 'TWO_FACTOR_CHALLENGE_INVALID'); }
};

export const refresh = async (req: Request, res: Response) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) {
    const hash = sha256(raw);
    const session = await prisma.refreshSession.findUnique({ where: { tokenHash: hash }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) return error(res, 'Refresh session expired', 401, undefined, 'REFRESH_EXPIRED');
    if (session.revokedAt) {
      await prisma.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'REUSE_DETECTED' } });
      res.clearCookie(REFRESH_COOKIE, cookieOptions);
      return error(res, 'Refresh token reuse detected', 401, undefined, 'REFRESH_REUSE');
    }
    const next = randomToken();
    await prisma.$transaction(async (tx: any) => {
      const replacement = await tx.refreshSession.create({
        data: {
          tenantId: session.tenantId,
          userId: session.userId,
          familyId: session.familyId,
          tokenHash: sha256(next),
          parentHash: hash,
          companyId: session.companyId,
          branchId: session.branchId,
          userAgent: req.get('user-agent'),
          ip: ipOf(req),
          expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400000),
        },
      });
      await tx.refreshSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokeReason: 'ROTATED', replacedById: replacement.id, lastUsedAt: new Date() },
      });
    });
    setRefresh(res, next);
    return success(res, await makePayload(session.user, { tenantId: session.tenantId, companyId: session.companyId, branchId: session.branchId }, session.user.twoFactorEnabled), 'Session refreshed');
  }

  // Fallback: If Authorization header is provided, refresh from bearer token
  const authHeader = req.headers.authorization?.split(' ')[1];
  if (authHeader) {
    try {
      const decoded: any = jwt.verify(authHeader, process.env.JWT_SECRET!);
      const user = await prisma.user.findUnique({ where: { id: decoded.id || decoded.sub }, include: { company: true } });
      if (!user || !user.isActive) return error(res, 'User not found or inactive', 401, undefined, 'USER_INACTIVE');
      if (decoded.tokenVersion !== undefined && user.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
        return error(res, 'Session revoked', 401, undefined, 'SESSION_REVOKED');
      }
      const context = await contextFor(user.id, user.companyId || undefined);
      return success(res, await makePayload(user, context, Boolean(decoded.twoFactorVerified)), 'Session refreshed');
    } catch {
      return error(res, 'Invalid or expired token', 401, undefined, 'TOKEN_INVALID');
    }
  }

  return error(res, 'Refresh token or authorization header required', 401, undefined, 'REFRESH_REQUIRED');
};

export const logout = async (req: AuthRequest, res: Response) => { const raw = req.cookies?.[REFRESH_COOKIE]; if (raw) await prisma.refreshSession.updateMany({ where: { tokenHash: sha256(raw), userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'LOGOUT' } }); res.clearCookie(REFRESH_COOKIE, cookieOptions); return success(res, null, 'Logged out'); };
export const logoutAll = async (req: AuthRequest, res: Response) => { await prisma.$transaction([prisma.refreshSession.updateMany({ where: { userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'LOGOUT_ALL' } }), prisma.user.update({ where: { id: req.user!.id }, data: { tokenVersion: { increment: 1 } } })]); res.clearCookie(REFRESH_COOKIE, cookieOptions); return success(res, null, 'All sessions revoked'); };

export const forgotPassword = async (req: Request, res: Response) => { const user = await prisma.user.findFirst({ where: { email: { equals: String(req.body.email || '').trim().toLowerCase(), mode: 'insensitive' } } }); let resetToken: string | undefined; if (user) { resetToken = randomToken(); await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(resetToken), expiresAt: new Date(Date.now() + 15 * 60000) } }); } return success(res, process.env.NODE_ENV === 'production' ? null : { resetToken }, 'If the account exists, reset instructions have been issued'); };
export const resetPassword = async (req: Request, res: Response) => { const invalid = passwordValidationMessage(req.body.password); if (invalid) return error(res, invalid, 400, undefined, 'VALIDATION_ERROR'); const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(String(req.body.token || '')) } }); if (!row || row.consumedAt || row.expiresAt <= new Date()) return error(res, 'Reset token is invalid or expired', 400, undefined, 'RESET_TOKEN_INVALID'); await prisma.$transaction([prisma.user.update({ where: { id: row.userId }, data: { password: await hashPassword(req.body.password), passwordChangedAt: new Date(), tokenVersion: { increment: 1 } } }), prisma.passwordResetToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } }), prisma.refreshSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'PASSWORD_RESET' } })]); return success(res, null, 'Password reset; all sessions revoked'); };

export const enrollTwoFactor = async (req: AuthRequest, res: Response) => { const secret = generateSecret(); await prisma.user.update({ where: { id: req.user!.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } }); const uri = generateURI({ issuer: 'Orus ERP', label: req.user!.email, secret }); return success(res, { secret, uri, qrDataUrl: await QRCode.toDataURL(uri) }, 'Scan and verify to enable two-factor authentication'); };
export const enableTwoFactor = async (req: AuthRequest, res: Response) => { const user = await prisma.user.findUnique({ where: { id: req.user!.id } }); if (!user?.twoFactorSecret || !(await verifyOtp({ secret: user.twoFactorSecret, token: String(req.body.code || '') })).valid) return error(res, 'Invalid verification code', 400, undefined, 'TWO_FACTOR_INVALID'); const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase()); await prisma.$transaction(async (tx: any) => { await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: user.id } }); await tx.twoFactorRecoveryCode.createMany({ data: codes.map((code) => ({ userId: user.id, codeHash: sha256(code) })) }); await tx.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } }); }); return success(res, { recoveryCodes: codes }, 'Two-factor authentication enabled'); };

export const getSessions = async (req: AuthRequest, res: Response) => success(res, await prisma.refreshSession.findMany({ where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, companyId: true, branchId: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true, expiresAt: true }, orderBy: { createdAt: 'desc' } }));
export const revokeSession = async (req: AuthRequest, res: Response) => { const result = await prisma.refreshSession.updateMany({ where: { id: req.params.id, userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'USER_REVOKED' } }); return result.count ? success(res, null, 'Session revoked') : error(res, 'Session not found', 404, undefined, 'SESSION_NOT_FOUND'); };
export const switchCompany = async (req: AuthRequest, res: Response) => { const membership = await prisma.companyMembership.findFirst({ where: { userId: req.user!.id, companyId: req.body.companyId, isActive: true } }); if (!membership) return error(res, 'Company membership not found', 403, undefined, 'COMPANY_FORBIDDEN'); if (req.body.branchId && !await prisma.branch.findFirst({ where: { id: req.body.branchId, tenantId: membership.tenantId, companyId: membership.companyId, isActive: true } })) return error(res, 'Branch not found', 404, undefined, 'BRANCH_NOT_FOUND'); const context = { tenantId: membership.tenantId, companyId: membership.companyId, branchId: req.body.branchId || membership.defaultBranchId }; const user = await prisma.user.findUnique({ where: { id: req.user!.id } }); return success(res, await makePayload(user, context, Boolean(req.user!.twoFactorVerified)), 'Company switched'); };

export const getMe = async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      avatar: true,
      role: true,
      companyId: true,
      company: true,
      isActive: true,
      twoFactorEnabled: true,
      createdAt: true,
      tenantMemberships: { include: { tenant: true } },
      companyMemberships: { include: { company: true } },
    },
  });
  return user ? success(res, { ...user, access: req.access, activeContext: req.context }) : error(res, 'User not found', 404, undefined, 'USER_NOT_FOUND');
};

export const updateProfile = async (req: AuthRequest, res: Response) => {
  const { firstName, lastName, phone, avatar } = req.body;
  return success(
    res,
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { firstName, lastName, phone, avatar },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, avatar: true, role: true },
    }),
    'Profile updated'
  );
};

export const changePassword = async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  const invalid = passwordValidationMessage(req.body.newPassword);
  if (!user || !(await verifyPassword(user.password, req.body.currentPassword)))
    return error(res, 'Current password is incorrect', 400, undefined, 'PASSWORD_INCORRECT');
  if (invalid) return error(res, invalid, 400, undefined, 'VALIDATION_ERROR');
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { password: await hashPassword(req.body.newPassword), passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
    }),
    prisma.refreshSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'PASSWORD_CHANGED' },
    }),
  ]);
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  return success(res, null, 'Password changed; sign in again');
};

export const getUsers = async (req: Request, res: Response) => {
  const companyId = (req as AuthRequest).user?.companyId;
  return success(
    res,
    await prisma.user.findMany({
      where: companyId ? { companyId } : undefined,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        companyId: true,
        isActive: true,
        twoFactorEnabled: true,
        createdAt: true,
        accessRoles: { include: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  );
};

