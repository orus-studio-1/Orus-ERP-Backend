import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { error } from '../utils/response';
import { computeEffectiveAccess, firstPathSegment, getActionForRequest, hasPermission, EffectiveAccess } from '../utils/accessControl';
import { runWithTenant } from '../utils/tenant';

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
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role, companyId: decoded.companyId };
    req.access = await computeEffectiveAccess(decoded.id);
    if (!req.user.companyId && req.access.companyId) req.user.companyId = req.access.companyId;
    runWithTenant(req.user.companyId, () => next());
  } catch {
    error(res, 'Invalid or expired token', 401);
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
