import { Request, Response, NextFunction } from 'express';
import { Errors } from '../utils/AppError';

/**
 * authorise.ts — role-based access control + org scoping.
 *
 * Two concerns handled here:
 *   1. Role guard: only certain roles can access certain routes
 *   2. Org scoping: an admin at Church A can NEVER touch Church B's data
 *
 * Org scoping is enforced by comparing req.user.orgId against the
 * :orgId route param or request body org_id. This is the critical
 * multi-tenant isolation guard.
 */

type Role = 'ADMIN' | 'TREASURER' | 'SIGNATORY' | 'MEMBER';

/**
 * requireRole — middleware factory that allows only specified roles.
 *
 * Usage:
 *   router.post('/payouts', authenticateAdmin, requireRole(['ADMIN', 'TREASURER']), ...)
 */
export function requireRole(allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as any).user;

    if (!user) {
      return next(Errors.unauthorized());
    }

    if (!allowedRoles.includes(user.role as Role)) {
      return next(
        Errors.forbidden(
          `Role '${user.role}' cannot access this resource. Required: ${allowedRoles.join(' or ')}.`,
        ),
      );
    }

    next();
  };
}

/**
 * scopeToOrg — ensures the authenticated user belongs to the org
 * specified in the route param :orgId.
 *
 * Prevents: admin at Church A accessing Church B's dashboard by
 * swapping the org ID in the URL.
 *
 * Usage:
 *   router.get('/orgs/:orgId/funds', authenticateAdmin, scopeToOrg, ...)
 */
export function scopeToOrg(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as any).user;
  // The org router names its param :id (PATCH /orgs/:id) while nested
  // mounts use :orgId — check both, otherwise the guard silently skips
  // and any admin can modify any other church.
  const routeOrgId = req.params.orgId ?? req.params.id;

  if (!user) return next(Errors.unauthorized());

  // System-level routes without :orgId param — skip scope check
  if (!routeOrgId) return next();

  if (user.orgId !== routeOrgId) {
    return next(
      Errors.forbidden('You do not have access to this organisation\'s data.'),
    );
  }

  next();
}

/**
 * requireInitiator — only allows signatories with can_initiate=true
 * to create payout requests. Checked after authenticateAdmin.
 */
export function requireInitiator(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as any).user;

  if (!user) return next(Errors.unauthorized());

  // ADMINs can always initiate
  if (user.role === 'ADMIN') return next();

  // TREASURERs can initiate (can_initiate is embedded in their token)
  if (user.role === 'TREASURER' && user.canInitiate) return next();

  return next(
    Errors.forbidden('Only designated treasurers can initiate payout requests.'),
  );
}