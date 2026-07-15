import { PoolClient } from 'pg';
import { query } from '../../db';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';

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
  feeKobo?:     number; // Nomba inbound fee — wallet received amountKobo − feeKobo
  period:       string; // 'YYYY-MM'
  /**
   * member_count_paid tracks UNIQUE givers per period, not payment count.
   * Pass true only for a member's first payment to this fund this period;
   * false for repeat payments and for anonymous/shared inflows (no identity).
   */
  isFirstGiftThisPeriod?: boolean;
}

export interface LedgerDebitInput {
  org_id:       string;
  fund_type_id: string;
  amountKobo:   number;
  feeKobo?:     number; // Nomba transfer fee — wallet was debited amountKobo + feeKobo
  period:       string;
}

export interface FundBalance {
  total_collected_kobo: number;
  total_paid_out_kobo:  number;
  total_fees_kobo:      number;
  soft_lock_kobo:       number;
  available_kobo:       number; // computed: collected - fees - paid_out - soft_lock
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
    const { org_id, fund_type_id, amountKobo, feeKobo = 0, period,
            isFirstGiftThisPeriod = false } = input;

    await client.query(
      `INSERT INTO fund_ledger
         (org_id, fund_type_id, total_collected_kobo, total_paid_out_kobo,
          total_fees_kobo, soft_lock_kobo, member_count_paid, total_transactions,
          period_month, updated_at)
       VALUES ($1, $2, $3, 0, $4, 0, $6, 1, $5, NOW())
       ON CONFLICT (org_id, fund_type_id, period_month)
       DO UPDATE SET
         total_collected_kobo = fund_ledger.total_collected_kobo + EXCLUDED.total_collected_kobo,
         total_fees_kobo      = fund_ledger.total_fees_kobo + EXCLUDED.total_fees_kobo,
         member_count_paid    = fund_ledger.member_count_paid + EXCLUDED.member_count_paid,
         total_transactions   = fund_ledger.total_transactions + 1,
         updated_at           = NOW()`,
      [org_id, fund_type_id, amountKobo, feeKobo, period, isFirstGiftThisPeriod ? 1 : 0],
    );
  },

  /**
   * debitLedger — increments total_paid_out_kobo after a successful payout transfer.
   * Also releases the soft_lock_kobo that was set when the payout was initiated.
   *
   * Called by nomba-transfer.service.ts after transfer.success webhook.
   */
  async debitLedger(
    client: PoolClient,
    input: LedgerDebitInput & { lockedPeriod?: string | null },
  ): Promise<void> {
    const { org_id, fund_type_id, amountKobo, feeKobo = 0, period, lockedPeriod } = input;

    // Upsert, not UPDATE: if no collections have landed this month there is
    // no current-period row yet, and a plain UPDATE would match nothing —
    // silently losing the debit while real money left the wallet.
    await client.query(
      `INSERT INTO fund_ledger
         (org_id, fund_type_id, total_collected_kobo, total_paid_out_kobo,
          total_fees_kobo, soft_lock_kobo, member_count_paid, total_transactions,
          period_month, updated_at)
       VALUES ($1, $2, 0, $3, $4, 0, 0, 0, $5, NOW())
       ON CONFLICT (org_id, fund_type_id, period_month)
       DO UPDATE SET
         total_paid_out_kobo = fund_ledger.total_paid_out_kobo + EXCLUDED.total_paid_out_kobo,
         total_fees_kobo     = fund_ledger.total_fees_kobo + EXCLUDED.total_fees_kobo,
         updated_at          = NOW()`,
      [org_id, fund_type_id, amountKobo, feeKobo, period],
    );

    // Release the reservation from the row it was actually locked on —
    // which may be an earlier month than the debit row.
    await client.query(
      `UPDATE fund_ledger
       SET soft_lock_kobo = GREATEST(0, soft_lock_kobo - $3), updated_at = NOW()
       WHERE org_id = $1 AND fund_type_id = $2
         AND period_month = COALESCE($4, (
           SELECT period_month FROM fund_ledger
           WHERE org_id = $1 AND fund_type_id = $2 AND soft_lock_kobo > 0
           ORDER BY period_month DESC LIMIT 1
         ))`,
      [org_id, fund_type_id, amountKobo, lockedPeriod ?? null],
    );
  },

  /**
   * checkAndLock — ATOMIC balance-check + soft-lock. Must run inside the
   * caller's withTransaction().
   *
   * Locks every fund_ledger row for this fund with SELECT … FOR UPDATE, so
   * two payouts initiated concurrently serialise: the second waits on the
   * row lock, then sees the first one's soft_lock and fails the balance
   * gate — closing the read-then-write race where both could pass and
   * together over-commit the fund.
   *
   * Returns the period_month the lock landed on. Persist it on the payout
   * row so release/debit later target the SAME row (cross-month safe).
   *
   * @throws 422 UNPROCESSABLE when available < amountKobo + feeBufferKobo
   */
  async checkAndLock(client: PoolClient, input: {
    org_id:        string;
    fund_type_id:  string;
    amountKobo:    number;
    feeBufferKobo: number;
  }): Promise<{ lockedPeriod: string; availableKobo: number }> {
    const { org_id, fund_type_id, amountKobo, feeBufferKobo } = input;

    // FOR UPDATE cannot combine with aggregates — lock the raw rows, sum here
    const res = await client.query<{
      period_month:         string;
      total_collected_kobo: string;
      total_paid_out_kobo:  string;
      total_fees_kobo:      string;
      soft_lock_kobo:       string;
    }>(
      `SELECT period_month, total_collected_kobo, total_paid_out_kobo,
              total_fees_kobo, soft_lock_kobo
       FROM fund_ledger
       WHERE org_id = $1 AND fund_type_id = $2
       ORDER BY period_month DESC
       FOR UPDATE`,
      [org_id, fund_type_id],
    );

    let collected = 0, paidOut = 0, fees = 0, softLock = 0;
    for (const r of res.rows) {
      collected += Number(r.total_collected_kobo);
      paidOut   += Number(r.total_paid_out_kobo);
      fees      += Number(r.total_fees_kobo);
      softLock  += Number(r.soft_lock_kobo);
    }
    const available = Math.max(0, collected - fees - paidOut - softLock);

    if (res.rows.length === 0 || available < amountKobo + feeBufferKobo) {
      throw Errors.unprocessable(
        `Insufficient balance. Available: ₦${(available / 100).toLocaleString()}, ` +
        `Requested: ₦${(amountKobo / 100).toLocaleString()} ` +
        `(plus ₦${(feeBufferKobo / 100).toLocaleString()} Nomba transfer fee)`,
      );
    }

    const lockedPeriod = res.rows[0].period_month;
    await client.query(
      `UPDATE fund_ledger
       SET soft_lock_kobo = soft_lock_kobo + $3, updated_at = NOW()
       WHERE org_id = $1 AND fund_type_id = $2 AND period_month = $4`,
      [org_id, fund_type_id, amountKobo, lockedPeriod],
    );

    logger.info({ org_id, fund_type_id, amountKobo, locked_period: lockedPeriod },
      '[Ledger] Balance checked and soft-locked atomically');

    return { lockedPeriod, availableKobo: available };
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

    // Lock against the latest period row so cross-month payouts work correctly
    await query(
      `UPDATE fund_ledger
       SET soft_lock_kobo = soft_lock_kobo + $3, updated_at = NOW()
       WHERE org_id = $1 AND fund_type_id = $2
         AND period_month = (
           SELECT period_month FROM fund_ledger
           WHERE org_id = $1 AND fund_type_id = $2
           ORDER BY period_month DESC LIMIT 1
         )`,
      [org_id, fund_type_id, amountKobo],
    );

    logger.info({ org_id, fund_type_id, amountKobo },
      '[Ledger] Soft-locked balance for pending payout');
  },

  /**
   * releaseLock — releases the soft lock when a payout is declined,
   * expired, cancelled, or fails. Funds become available again.
   *
   * Pass lockedPeriod (payout_requests.locked_period_month) so the release
   * hits the exact row the lock was applied to. Falls back to the latest
   * locked row for legacy payouts created before the column existed.
   */
  async releaseLock(input: {
    org_id:        string;
    fund_type_id:  string;
    amountKobo:    number;
    lockedPeriod?: string | null;
  }): Promise<void> {
    const { org_id, fund_type_id, amountKobo, lockedPeriod } = input;

    await query(
      `UPDATE fund_ledger
       SET soft_lock_kobo = GREATEST(0, soft_lock_kobo - $3), updated_at = NOW()
       WHERE org_id = $1 AND fund_type_id = $2
         AND period_month = COALESCE($4, (
           SELECT period_month FROM fund_ledger
           WHERE org_id = $1 AND fund_type_id = $2 AND soft_lock_kobo > 0
           ORDER BY period_month DESC LIMIT 1
         ))`,
      [org_id, fund_type_id, amountKobo, lockedPeriod ?? null],
    );

    logger.info({ org_id, fund_type_id, amountKobo, locked_period: lockedPeriod ?? 'latest' },
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
      total_fees_kobo:      string;
      soft_lock_kobo:       string;
      member_count_paid:    string;
      total_transactions:   string;
    }>(
      `SELECT
         COALESCE(SUM(total_collected_kobo), 0)::TEXT AS total_collected_kobo,
         COALESCE(SUM(total_paid_out_kobo),  0)::TEXT AS total_paid_out_kobo,
         COALESCE(SUM(total_fees_kobo),      0)::TEXT AS total_fees_kobo,
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
    const fees      = Number(row.total_fees_kobo);
    const softLock  = Number(row.soft_lock_kobo);

    return {
      total_collected_kobo: collected,
      total_paid_out_kobo:  paidOut,
      total_fees_kobo:      fees,
      soft_lock_kobo:       softLock,
      // Fees are subtracted so "available" mirrors the real Nomba wallet
      available_kobo:       Math.max(0, collected - fees - paidOut - softLock),
      member_count_paid:    Number(row.member_count_paid),
      total_transactions:   Number(row.total_transactions),
    };
  },
};