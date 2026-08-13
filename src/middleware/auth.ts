import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { error } from '../utils/response';
import { computeEffectiveAccess, firstPathSegment, getActionForRequest, hasPermission, EffectiveAccess } from '../utils/accessControl';
import { runWithTenant } from '../utils/tenant';
import prisma from '../lib/prisma';

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; companyId?: string | null };
  access?: EffectiveAccess;
  permissionGatePassed?: boolean;
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    error(res, 'No token provided', 401);
    return;
  }
  let decoded: any;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
  } catch {
    error(res, 'Invalid or expired token', 401);
    return;
  }

  try {
    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true, companyId: true, isActive: true },
    });
    if (!currentUser || !currentUser.isActive) {
      error(res, 'Account is inactive or no longer exists', 401);
      return;
    }
    req.user = { id: currentUser.id, email: currentUser.email, role: currentUser.role, companyId: currentUser.companyId };
    req.access = await computeEffectiveAccess(decoded.id);
    if (!req.user.companyId && req.access.companyId) req.user.companyId = req.access.companyId;
    runWithTenant(req.user.companyId, () => next());
  } catch (err: any) {
    console.error('Unable to load authenticated session:', err);
    error(res, 'Unable to load your session. Please try again.', 500);
  }
};

export const authorize = (...roles: string[]) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (req.access?.isSuperAdmin || req.permissionGatePassed) {
      next();
      return;
    }
    if (!req.user || !roles.includes(req.user.role)) {
      error(res, 'Insufficient permissions', 403);
      return;
    }
    next();
  };

export const requirePermission = (module: string, resource: string, action: any) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (hasPermission(req.access, module, resource, action)) {
      req.permissionGatePassed = true;
      next();
      return;
    }
    error(res, `Missing permission: ${module}:${resource}:${action}`.toLowerCase(), 403);
  };

export const requireModuleAccess = (module: string, resourceResolver?: (req: Request) => string) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    const action = getActionForRequest(req.method, req.path);
    const resource = resourceResolver ? resourceResolver(req) : firstPathSegment(req.path);
    if (hasPermission(req.access, module, resource, action)) {
      req.permissionGatePassed = true;
      next();
      return;
    }
    error(res, `Access denied for ${action.toLowerCase()} on ${module}/${resource}`, 403);
  };
