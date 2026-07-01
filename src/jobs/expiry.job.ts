import { query, queryMany } from '../db';
import { logger } from '../utils/logger';

/**
 * expiry.job.ts — hourly expiry cleanup.
 *
 * Three expiry tasks in one job (hourly, lightweight):
 *
 *   1. OTP tokens       — mark expired OTPs as used to prevent late verification
 *   2. Approval tokens  — auto-decline payout requests past auto_decline_hours
 *   3. Campaign VAs     — deactivate expired campaign fund types
 *
 * schedule: '0 * * * *'  → top of every hour
 */
export async function runExpiryJob(): Promise<void> {
  logger.info('[ExpiryJob] Starting hourly expiry cleanup');

  await Promise.allSettled([
    expireOtpTokens(),
    expirePayoutRequests(),
    expireCampaignFunds(),
  ]);

  logger.info('[ExpiryJob] Expiry cleanup complete');
}

/**
 * 1. Expire OTP tokens past their TTL.
 * Marks them as used so late verify attempts fail cleanly.
 */
async function expireOtpTokens(): Promise<void> {
  try {
    const result = await query(
      `UPDATE otp_tokens
       SET used_at = NOW()
       WHERE expires_at < NOW() AND used_at IS NULL`,
    );
    logger.debug({ rows: result.rowCount }, '[ExpiryJob] OTP tokens expired');
  } catch (err: any) {
    logger.error({ err: err.message }, '[ExpiryJob] OTP expiry failed');
  }
}

/**
 * 2. Auto-decline payout requests past their auto_decline deadline.
 * Releases soft_lock so funds are available again.
 */
async function expirePayoutRequests(): Promise<void> {
  try {
    // Find all overdue PENDING/PARTIAL requests
    const expired = await queryMany<{
      id: string; org_id: string; fund_type_id: string; amount_kobo: number;
    }>(
      `SELECT id, org_id, fund_type_id, amount_kobo FROM payout_requests
       WHERE status IN ('PENDING','PARTIAL')
         AND expires_at < NOW()`,
    );

    if (expired.length === 0) return;

    for (const req of expired) {
      // Mark as EXPIRED
      await query(
        `UPDATE payout_requests SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
        [req.id],
      );

      // Release soft lock — funds back in available balance
      await query(
        `UPDATE fund_ledger
         SET soft_lock_kobo = GREATEST(0, soft_lock_kobo - $1), updated_at = NOW()
         WHERE org_id = $2 AND fund_type_id = $3`,
        [req.amount_kobo, req.org_id, req.fund_type_id],
      );

      logger.info({ payout_id: req.id, amount_kobo: req.amount_kobo },
        '[ExpiryJob] Payout request expired — soft lock released');
    }

    logger.info({ count: expired.length }, '[ExpiryJob] Expired payout requests processed');
  } catch (err: any) {
    logger.error({ err: err.message }, '[ExpiryJob] Payout expiry failed');
  }
}

/**
 * 3. Deactivate expired campaign fund types.
 * Also invalidates any member VAs for these funds via is_active flag.
 */
async function expireCampaignFunds(): Promise<void> {
  try {
    const result = await query(
      `UPDATE fund_types
       SET is_active = FALSE, updated_at = NOW()
       WHERE kind = 'CAMPAIGN'
         AND is_active = TRUE
         AND expires_at < NOW()
       RETURNING id, name, org_id`,
    );

    if ((result.rowCount ?? 0) > 0) {
      logger.info({ count: result.rowCount, funds: result.rows.map(r => r.name) },
        '[ExpiryJob] Campaign funds deactivated');
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '[ExpiryJob] Campaign expiry failed');
  }
}