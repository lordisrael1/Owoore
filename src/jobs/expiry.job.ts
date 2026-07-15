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
      locked_period_month: string | null;
    }>(
      `SELECT id, org_id, fund_type_id, amount_kobo, locked_period_month
       FROM payout_requests
       WHERE status IN ('PENDING','PARTIAL')
         AND expires_at < NOW()`,
    );

    if (expired.length === 0) return;

    let expiredCount = 0;
    for (const req of expired) {
      // COMPARE-AND-SET, not a blind write: between our SELECT and this
      // UPDATE a signatory can approve (status → APPROVED → TRANSFERRING,
      // real money moving). Stomping that to EXPIRED and releasing the
      // lock would make the later transfer.success webhook drop its ledger
      // debit — money leaves the wallet with no record. Only a row still
      // PENDING/PARTIAL may expire; otherwise skip and touch nothing.
      const updated = await query(
        `UPDATE payout_requests
         SET status = 'EXPIRED', updated_at = NOW()
         WHERE id = $1 AND status IN ('PENDING','PARTIAL')
         RETURNING id`,
        [req.id],
      );

      if ((updated.rowCount ?? 0) === 0) {
        logger.info({ payout_id: req.id },
          '[ExpiryJob] Payout advanced during expiry sweep — skipped');
        continue;
      }

      // Release soft lock — targeted at the exact period row it was
      // applied to (the old unfiltered UPDATE subtracted the amount from
      // EVERY period row of the fund).
      const { ledgerService } = await import('../modules/transactions/ledger.service');
      await ledgerService.releaseLock({
        org_id:       req.org_id,
        fund_type_id: req.fund_type_id,
        amountKobo:   req.amount_kobo,
        lockedPeriod: req.locked_period_month,
      });

      expiredCount++;
      logger.info({ payout_id: req.id, amount_kobo: req.amount_kobo },
        '[ExpiryJob] Payout request expired — soft lock released');
    }

    logger.info({ count: expiredCount, scanned: expired.length },
      '[ExpiryJob] Expired payout requests processed');
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