import { Request, Response, NextFunction } from 'express';
import { verifyToken, MemberTokenPayload, AdminTokenPayload, adminTokenVersionCacheKey } from '../config/jwt';
import { Errors } from '../utils/AppError';
import { getOrSetWithLock } from '../utils/cacheAside';
import { queryOne } from '../db';

/**
 * authenticate — verifies the Authorization: Bearer <token> header.
 *
 * Attaches req.user with the decoded JWT payload.
 * Works for both member tokens and admin tokens — the payload's
 * `role` field distinguishes them.
 *
 * HEADER ONLY — no ?token= query fallback. A JWT in a URL is written to
 * server logs, browser history, and Referer headers, and stays replayable
 * until expiry. CSV downloads now fetch with the header and save via Blob.
 *
 * Throws 401 if:
 *   - No Authorization header
 *   - Token is malformed
 *   - Token is expired
 *   - Token signature is invalid
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    return next(Errors.unauthorized('No token provided. Include Authorization: Bearer <token>'));
  }

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
 *
 * Also enforces token_version: admin JWTs are otherwise fully stateless
 * (1-day expiry, no DB check), so logout-everywhere and revoking a
 * deactivated teammate's access both work by bumping admin_users.token_version
 * — this is the one place that's checked. Redis-cached (~30s) via
 * getOrSetWithLock so revocation isn't instant, but every admin request
 * doesn't pay a DB round trip either; Redis being down degrades to a
 * direct DB check per request, never to skipping the check.
 */
export function authenticateAdmin(req: Request, _res: Response, next: NextFunction): void {
  authenticate(req, _res, async (err) => {
    if (err) return next(err);
    const user = (req as any).user as MemberTokenPayload | AdminTokenPayload;
    if (!['ADMIN', 'TREASURER', 'SIGNATORY'].includes(user.role)) {
      return next(Errors.forbidden('Admin access required.'));
    }

    const admin = user as AdminTokenPayload;
    try {
      const currentVersion = await getOrSetWithLock<number | null>({
        key:        adminTokenVersionCacheKey(admin.sub),
        ttlSeconds: 30,
        fetch: async () => {
          const row = await queryOne<{ token_version: number }>(
            `SELECT token_version FROM admin_users WHERE id = $1`,
            [admin.sub],
          );
          // null = "no row to check against" — there is currently no way
          // to delete an admin_users row (only deactivate, which keeps
          // the row and bumps token_version), so this only happens for a
          // token that was never backed by a real account. Can't forge
          // one without JWT_SECRET, so admitting it isn't a live hole —
          // revisit if a real delete-admin feature is ever added.
          return row ? row.token_version : null;
        },
      });

      if (currentVersion !== null && (admin.tokenVersion ?? 0) !== currentVersion) {
        return next(Errors.unauthorized('Session no longer valid. Please log in again.'));
      }
    } catch (dbErr: any) {
      // A genuine DB failure here must not silently admit a possibly-revoked
      // session — fail closed, not open.
      return next(Errors.unauthorized('Could not verify session. Please try again.'));
    }

    next();
  });
}