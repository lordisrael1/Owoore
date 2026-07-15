import jwt, { SignOptions, JwtPayload } from 'jsonwebtoken';
import { env } from './env';

// ── Payload shapes ─────────────────────────────────────────────────────────

export interface MemberTokenPayload extends JwtPayload {
  sub: string;        // member UUID
  orgId: string;      // org UUID
  email: string;
  role: 'MEMBER';
}

export interface AdminTokenPayload extends JwtPayload {
  sub: string;        // admin_user UUID
  orgId: string;      // org UUID
  email: string;
  role: 'ADMIN' | 'TREASURER' | 'SIGNATORY';
  tokenVersion: number; // must match admin_users.token_version — bumping it kills every existing token
}

export type TokenPayload = MemberTokenPayload | AdminTokenPayload;

// ── Sign ───────────────────────────────────────────────────────────────────

/**
 * signMemberToken — issues a JWT for a church member.
 * Stored in localStorage on the member's browser.
 */
export function signMemberToken(
  payload: Omit<MemberTokenPayload, 'iat' | 'exp'>,
): string {
  const options: SignOptions = {
    expiresIn: env.JWT_MEMBER_EXPIRES_IN as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

/**
 * signAdminToken — issues a JWT for a church admin or treasurer.
 * Shorter expiry than member tokens — admins handle sensitive actions.
 */
export function signAdminToken(
  payload: Omit<AdminTokenPayload, 'iat' | 'exp'>,
): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ADMIN_EXPIRES_IN as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

// ── Verify ─────────────────────────────────────────────────────────────────

/**
 * verifyToken — decodes and verifies any Owoore JWT.
 * Throws JsonWebTokenError or TokenExpiredError on failure —
 * the authenticate middleware catches these and returns 401.
 */
export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
}

/**
 * isMemberToken / isAdminToken — type guards used in middleware
 * to narrow the payload without unsafe casting.
 */
export function isMemberToken(payload: TokenPayload): payload is MemberTokenPayload {
  return payload.role === 'MEMBER';
}

export function isAdminToken(payload: TokenPayload): payload is AdminTokenPayload {
  return ['ADMIN', 'TREASURER', 'SIGNATORY'].includes(payload.role);
}

/** Redis key holding the cached current token_version for one admin. */
export const adminTokenVersionCacheKey = (adminId: string): string =>
  `admin_token_version:${adminId}`;

/**
 * evictAdminTokenVersionCache — call right after bumping token_version in
 * the DB so the change takes effect on the very next request instead of
 * waiting out the ~30s cache TTL in authenticateAdmin. Best-effort: a
 * Redis hiccup here just means revocation takes up to 30s instead of
 * being instant — never a reason to fail the logout/revoke action itself.
 */
export async function evictAdminTokenVersionCache(adminId: string): Promise<void> {
  try {
    const { getRedisClient } = await import('./redis');
    const redis = await getRedisClient();
    await redis.del(adminTokenVersionCacheKey(adminId));
  } catch (err: any) {
    const { logger } = await import('../utils/logger');
    logger.warn({ adminId, err: err.message },
      '[JWT] Failed to evict cached token_version — will self-correct within ~30s');
  }
}