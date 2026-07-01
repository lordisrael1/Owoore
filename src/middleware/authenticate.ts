import { Request, Response, NextFunction } from 'express';
import { verifyToken, MemberTokenPayload, AdminTokenPayload } from '../config/jwt';
import { Errors } from '../utils/AppError';

/**
 * authenticate — verifies the Authorization: Bearer <token> header.
 *
 * Attaches req.user with the decoded JWT payload.
 * Works for both member tokens and admin tokens — the payload's
 * `role` field distinguishes them.
 *
 * Throws 401 if:
 *   - No Authorization header
 *   - Token is malformed
 *   - Token is expired
 *   - Token signature is invalid
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(Errors.unauthorized('No token provided. Include Authorization: Bearer <token>'));
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyToken(token);
    (req as any).user = payload;
    (req as any).orgId = payload.orgId;
    next();
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') {
      return next(Errors.unauthorized('Session expired. Please log in again.'));
    }
    return next(Errors.unauthorized('Invalid token.'));
  }
}

/**
 * authenticateMember — authenticate + assert role is MEMBER.
 * Use on member-only routes (member portal, VA creation, giving history).
 */
export function authenticateMember(req: Request, _res: Response, next: NextFunction): void {
  authenticate(req, _res, (err) => {
    if (err) return next(err);
    const user = (req as any).user as MemberTokenPayload | AdminTokenPayload;
    if (user.role !== 'MEMBER') {
      return next(Errors.forbidden('This endpoint is for church members only.'));
    }
    next();
  });
}

/**
 * authenticateAdmin — authenticate + assert role is ADMIN or TREASURER.
 * Use on admin dashboard routes (fund management, member list, payout initiation).
 */
export function authenticateAdmin(req: Request, _res: Response, next: NextFunction): void {
  authenticate(req, _res, (err) => {
    if (err) return next(err);
    const user = (req as any).user as MemberTokenPayload | AdminTokenPayload;
    if (!['ADMIN', 'TREASURER', 'SIGNATORY'].includes(user.role)) {
      return next(Errors.forbidden('Admin access required.'));
    }
    next();
  });
}