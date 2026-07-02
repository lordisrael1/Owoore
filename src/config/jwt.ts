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