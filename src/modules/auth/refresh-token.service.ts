import { randomBytes } from 'crypto';
import { query, queryOne } from '../../db';
import { hashToken, verifyTokenHash } from '../../utils/crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';

/**
 * refresh-token.service.ts
 *
 * Long-lived, DB-tracked refresh tokens for members — independent of the
 * short-lived access token's expiry. Same security model as the payout
 * approval tokens: opaque random value, only the SHA-256 hash is stored,
 * the raw value is returned to the client exactly once.
 *
 * Rotating: verify() revokes the row it matched. The caller must always
 * issue a fresh token on successful verify — never hand back the same one.
 */
export const refreshTokenService = {
  /**
   * issue — creates a new refresh token row for a member.
   * Returns the raw token (send to client) — never stored.
   */
  async issue(memberId: string): Promise<{ rawToken: string; expiresAt: Date }> {
    const rawToken  = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + env.JWT_MEMBER_REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
    );

    await query(
      `INSERT INTO member_refresh_tokens (member_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [memberId, tokenHash, expiresAt],
    );

    return { rawToken, expiresAt };
  },

  /**
   * verify — validates an incoming raw refresh token and rotates it.
   *
   * Checks:
   *   1. Token exists
   *   2. Not expired
   *   3. Not already revoked (revoked + reused = theft signal — revoke
   *      every other active token for that member as a precaution)
   *
   * On success, revokes the matched row (rotation) and returns the
   * member_id so the caller can issue a fresh access + refresh token pair.
   */
  async verify(rawToken: string): Promise<{ memberId: string }> {
    const tokenHash = hashToken(rawToken);

    const row = await queryOne<{
      id:         string;
      member_id:  string;
      token_hash: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, member_id, token_hash, expires_at, revoked_at
       FROM member_refresh_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );

    if (!row || !verifyTokenHash(rawToken, row.token_hash)) {
      throw Errors.unauthorized('Invalid refresh token. Please log in again.');
    }

    if (row.revoked_at) {
      logger.warn({ member_id: row.member_id }, '[RefreshToken] Reuse of revoked token — revoking all sessions');
      await this.revokeAll(row.member_id);
      throw Errors.unauthorized('This session has already been used. Please log in again.');
    }

    if (new Date() > new Date(row.expires_at)) {
      throw Errors.unauthorized('Session expired. Please log in again.');
    }

    await query(
      `UPDATE member_refresh_tokens SET revoked_at = NOW() WHERE id = $1`,
      [row.id],
    );

    return { memberId: row.member_id };
  },

  /**
   * revokeAll — invalidates every active refresh token for a member.
   * Called on detected token reuse, and available for a future logout-all-devices flow.
   */
  async revokeAll(memberId: string): Promise<void> {
    await query(
      `UPDATE member_refresh_tokens
       SET revoked_at = NOW()
       WHERE member_id = $1 AND revoked_at IS NULL`,
      [memberId],
    );
  },
};
