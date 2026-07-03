import { randomUUID } from 'crypto';
import { signMemberToken, signAdminToken } from '../src/config/jwt';

/**
 * helpers.ts — shared test utilities.
 *
 * Tokens are signed with the real JWT_SECRET from .env, so they pass
 * the authenticate middleware exactly like production tokens. The IDs
 * inside are random UUIDs — org-scoped queries simply return empty
 * result sets, which lets us test guards and shapes without seeding.
 */

export function makeMemberToken(orgId: string = randomUUID()): string {
  return signMemberToken({
    sub:   randomUUID(),
    orgId,
    email: `member_${randomUUID().slice(0, 8)}@test.local`,
    role:  'MEMBER',
  });
}

export function makeAdminToken(
  role: 'ADMIN' | 'TREASURER' | 'SIGNATORY' = 'ADMIN',
  orgId: string = randomUUID(),
): string {
  return signAdminToken({
    sub:   randomUUID(),
    orgId,
    email: `admin_${randomUUID().slice(0, 8)}@test.local`,
    role,
  });
}

export const bearer = (token: string): string => `Bearer ${token}`;
