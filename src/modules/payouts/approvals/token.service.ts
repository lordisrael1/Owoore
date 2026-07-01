import { randomUUID } from 'crypto';
import { query, queryOne } from '../../../db';
import { hashToken } from '../../../utils/crypto';
import { logger } from '../../../utils/logger';
import { Errors } from '../../../utils/AppError';

/**
 * token.service.ts
 *
 * Manages single-use approval tokens sent in signatory emails.
 *
 * Security model:
 *   - Raw UUID token exists ONLY in the email link — never stored in DB
 *   - DB stores SHA-256 hash of the token
 *   - On approval page: incoming raw token is hashed and compared to stored hash
 *   - token_used_at is set on first use — prevents replay even if link is shared
 *   - token_expires_at enforced on every verification
 */

export const tokenService = {
  /**
   * generate — creates a fresh token for one signatory on one payout.
   *
   * Returns the raw token (for email link) and inserts the hash into DB.
   * The raw token is NEVER stored — only the hash.
   */
  async generate(input: {
    payoutRequestId: string;
    signatoryId:     string;
    expiryHours:     number;
    email:           string;
  }): Promise<{ rawToken: string; recordId: string }> {
    const { payoutRequestId, signatoryId, expiryHours, email } = input;

    const rawToken  = randomUUID();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const row = await queryOne<{ id: string }>(
      `INSERT INTO payout_approvals
         (payout_request_id, signatory_id, token, token_hash,
          token_expires_at, email_sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id`,
      [payoutRequestId, signatoryId, rawToken, tokenHash, expiresAt],
    );

    return { rawToken, recordId: row!.id };
  },

  /**
   * verify — validates an incoming raw token from the approval link.
   *
   * Checks:
   *   1. Token exists in DB
   *   2. Token hash matches
   *   3. Not expired
   *   4. Not already used
   *
   * Returns the approval record if valid, throws AppError otherwise.
   */
  async verify(rawToken: string): Promise<{
    id:               string;
    payout_request_id: string;
    signatory_id:     string;
    action:           string | null;
  }> {
    const row = await queryOne<{
      id:                string;
      payout_request_id: string;
      signatory_id:      string;
      token_hash:        string;
      token_expires_at:  Date;
      token_used_at:     Date | null;
      action:            string | null;
    }>(
      `SELECT id, payout_request_id, signatory_id, token_hash,
              token_expires_at, token_used_at, action
       FROM payout_approvals
       WHERE token = $1`,
      [rawToken],
    );

    if (!row) throw Errors.notFound('Approval token');

    if (row.token_used_at) throw Errors.tokenUsed();

    if (new Date() > new Date(row.token_expires_at)) throw Errors.tokenExpired();

    // Verify hash matches (timingSafeEqual inside hashToken comparison)
    const { verifyTokenHash } = await import('../../../utils/crypto');
    if (!verifyTokenHash(rawToken, row.token_hash)) {
      throw Errors.unauthorized('Invalid approval token');
    }

    return {
      id:               row.id,
      payout_request_id: row.payout_request_id,
      signatory_id:     row.signatory_id,
      action:           row.action,
    };
  },

  /**
   * markUsed — stamps token_used_at to prevent replay.
   * Called immediately after a valid approval or decline action is recorded.
   */
  async markUsed(approvalRecordId: string, ipAddress?: string): Promise<void> {
    await query(
      `UPDATE payout_approvals
       SET token_used_at = NOW(), ip_address = $2
       WHERE id = $1`,
      [approvalRecordId, ipAddress ?? null],
    );
  },

  /**
   * resend — invalidates the old token and generates a new one.
   * Called when admin clicks "Resend approval email" on the dashboard.
   * Rate-limited to once per hour per signatory per payout.
   */
  async resend(payoutRequestId: string, signatoryId: string, expiryHours: number): Promise<string> {
    const existing = await queryOne<{
      id: string; email_resent_count: number; email_sent_at: Date;
    }>(
      `SELECT id, email_resent_count, email_sent_at
       FROM payout_approvals
       WHERE payout_request_id = $1 AND signatory_id = $2`,
      [payoutRequestId, signatoryId],
    );

    if (!existing) throw Errors.notFound('Approval record');

    // Rate limit: max 1 resend per hour
    const lastSent = new Date(existing.email_sent_at);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (lastSent > oneHourAgo && existing.email_resent_count > 0) {
      throw Errors.tooManyRequests('Approval email already resent within the last hour');
    }

    // Generate new token — old token is implicitly invalidated (token field updated)
    const newRawToken  = randomUUID();
    const newTokenHash = hashToken(newRawToken);
    const newExpiry    = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    await query(
      `UPDATE payout_approvals
       SET token               = $2,
           token_hash          = $3,
           token_expires_at    = $4,
           token_used_at       = NULL,
           email_resent_count  = email_resent_count + 1,
           email_sent_at       = NOW()
       WHERE id = $1`,
      [existing.id, newRawToken, newTokenHash, newExpiry],
    );

    logger.info({ payout_request_id: payoutRequestId, signatory_id: signatoryId },
      '[TokenService] Approval token regenerated');

    return newRawToken;
  },
};