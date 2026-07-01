import { PoolClient } from 'pg';
import { query } from '../../db';
import { logger } from '../../utils/logger';

/**
 * ledger.service.ts
 *
 * Manages the fund_ledger table — the running balance per fund per period.
 *
 * All writes go through withTransaction() in the calling service.
 * This service receives the PoolClient and runs inside the caller's transaction
 * so ledger updates are atomic with transaction inserts.
 *
 * Key operations:
 *   creditLedger   — on inflow (member payment)
 *   debitLedger    — on payout transfer
 *   softLock       — reserve balance for pending payout approval
 *   releaseLock    — unlock reserved balance (on decline/expiry/cancel)
 *   getBalance     — available balance for a fund (total - paid_out - soft_lock)
 */

export interface LedgerCreditInput {
  org_id:       string;
  fund_type_id: string;
  amountKobo:   number;
  period:       string; // 'YYYY-MM'
}

export interface LedgerDebitInput {
  org_id:       string;
  fund_type_id: string;
  amountKobo:   number;
  period:       string;
}

export interface FundBalance {
  total_collected_kobo: number;
  total_paid_out_kobo:  number;
  soft_lock_kobo:       number;
  available_kobo:       number; // computed: collected - paid_out - soft_lock
  member_count_paid:    number;
  total_transactions:   number;
}

export const ledgerService = {
  /**
   * creditLedger — increments total_collected_kobo for the fund's current period.
   *
   * Uses INSERT ... ON CONFLICT UPDATE to upsert the period row atomically.
   * If no row exists for this period yet, it creates one.
   *
   * Must be called INSIDE a withTransaction() block from the calling service.
   */
  async creditLedger(client: PoolClient, input: LedgerCreditInput): Promise<void> {
    const { org_id, fund_type_id, amountKobo, period } = input;

    await client.query(
      `INSERT INTO fund_ledger
         (org_id, fund_type_id, total_collected_kobo, total_paid_out_kobo,
          soft_lock_kobo, member_count_paid, total_transactions, period_month, updated_at)
       VALUES ($1, $2, $3, 0, 0, 1, 1, $4, NOW())
       ON CONFLICT (org_id, fund_type_id, period_month)
       DO UPDATE SET
         total_collected_kobo = fund_ledger.total_collected_kobo + EXCLUDED.total_collected_kobo,
         total_transactions   = fund_ledger.total_transactions + 1,
         updated_at           = NOW()`,
      [org_id, fund_type_id, amountKobo, period],
    );
  },

  /**
   * debitLedger — increments total_paid_out_kobo after a successful payout transfer.
   * Also releases the soft_lock_kobo that was set when the payout was initiated.
   *
   * Called by nomba-transfer.service.ts after transfer.success webhook.
   */
  async debitLedger(client: PoolClient, input: LedgerDebitInput): Promise<void> {
    const { org_id, fund_type_id, amountKobo, period } = input;

    await client.query(
      `UPDATE fund_ledger
       SET
         total_paid_out_kobo = total_paid_out_kobo + $3,
         soft_lock_kobo      = GREATEST(0, soft_lock_kobo - $3),
         updated_at          = NOW()
       WHERE org_id = $1
         AND fund_type_id = $2
         AND period_month = $4`,
      [org_id, fund_type_id, amountKobo, period],
    );
  },

  /**
   * softLock — reserves amountKobo from the available balance
   * when a payout request is created (PENDING state).
   *
   * This prevents the same funds from being claimed by two payout requests.
   * The soft-locked amount is excluded from availableBalance calculations.
   */
  async softLock(input: { org_id: string; fund_type_id: string; amountKobo: number }): Promise<void> {
    const { org_id, fund_type_id, amountKobo } = input;
    const period = new Date().toISOString().slice(0, 7);

    await query(
      `UPDATE fund_ledger
       SET soft_lock_kobo = soft_lock_kobo + $3, updated_at = NOW()
       WHERE org_id = $1 AND fund_type_id = $2 AND period_month = $4`,
      [org_id, fund_type_id, amountKobo, period],
    );

    logger.info({ org_id, fund_type_id, amountKobo },
      '[Ledger] Soft-locked balance for pending payout');
  },

  /**
   * releaseLock — releases the soft lock when a payout is declined,
   * expired, cancelled, or fails. Funds become available again.
   */
  async releaseLock(input: { org_id: string; fund_type_id: string; amountKobo: number }): Promise<void> {
    const { org_id, fund_type_id, amountKobo } = input;
    const period = new Date().toISOString().slice(0, 7);

    await query(
      `UPDATE fund_ledger
       SET soft_lock_kobo = GREATEST(0, soft_lock_kobo - $3), updated_at = NOW()
       WHERE org_id = $1 AND fund_type_id = $2 AND period_month = $4`,
      [org_id, fund_type_id, amountKobo, period],
    );

    logger.info({ org_id, fund_type_id, amountKobo },
      '[Ledger] Released soft lock — funds available again');
  },

  /**
   * getBalance — returns the fund balance with available_kobo computed.
   *
   * available_kobo = total_collected - total_paid_out - soft_lock
   *
   * This is the value shown on the admin dashboard "Fund Balance" panel
   * and checked before initiating a payout.
   */
  async getBalance(org_id: string, fund_type_id: string): Promise<FundBalance> {
    const rows = await query<{
      total_collected_kobo: string;
      total_paid_out_kobo:  string;
      soft_lock_kobo:       string;
      member_count_paid:    string;
      total_transactions:   string;
    }>(
      `SELECT
         COALESCE(SUM(total_collected_kobo), 0)::TEXT AS total_collected_kobo,
         COALESCE(SUM(total_paid_out_kobo),  0)::TEXT AS total_paid_out_kobo,
         COALESCE(SUM(soft_lock_kobo),       0)::TEXT AS soft_lock_kobo,
         COALESCE(SUM(member_count_paid),    0)::TEXT AS member_count_paid,
         COALESCE(SUM(total_transactions),   0)::TEXT AS total_transactions
       FROM fund_ledger
       WHERE org_id = $1 AND fund_type_id = $2`,
      [org_id, fund_type_id],
    );

    const row = rows.rows[0];
    const collected = Number(row.total_collected_kobo);
    const paidOut   = Number(row.total_paid_out_kobo);
    const softLock  = Number(row.soft_lock_kobo);

    return {
      total_collected_kobo: collected,
      total_paid_out_kobo:  paidOut,
      soft_lock_kobo:       softLock,
      available_kobo:       Math.max(0, collected - paidOut - softLock),
      member_count_paid:    Number(row.member_count_paid),
      total_transactions:   Number(row.total_transactions),
    };
  },
};