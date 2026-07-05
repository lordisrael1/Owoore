import { queryOne, queryMany } from '../../db';

/**
 * dashboard.repository.ts
 *
 * Heavy aggregate SQL queries for the admin dashboard.
 * These are intentionally written as raw SQL with GROUP BY / SUM
 * rather than ORM abstractions — performance matters on dashboard loads.
 *
 * All queries are org-scoped — an admin only sees their church data.
 */

export const dashboardRepository = {
  /**
   * getFundBreakdown — fund totals for the current and previous period.
   * The main "Fund Balance" panel on the admin dashboard.
   */
  async getFundBreakdown(orgId: string, period?: string): Promise<Array<{
    fund_type_id:         string;
    fund_name:            string;
    kind:                 string;
    is_shared_va:         boolean;
    is_anonymous_only:    boolean;
    total_collected_kobo: number;
    total_paid_out_kobo:  number;
    total_fees_kobo:      number;
    soft_lock_kobo:       number;
    available_kobo:       number;
    member_count_paid:    number;
    total_transactions:   number;
  }>> {
    const currentPeriod = period ?? new Date().toISOString().slice(0, 7);

    return queryMany(
      `SELECT
         ft.id           AS fund_type_id,
         ft.name         AS fund_name,
         ft.kind,
         ft.is_shared_va,
         ft.is_anonymous_only,
         COALESCE(SUM(fl.total_collected_kobo), 0)::BIGINT AS total_collected_kobo,
         COALESCE(SUM(fl.total_paid_out_kobo),  0)::BIGINT AS total_paid_out_kobo,
         COALESCE(SUM(fl.total_fees_kobo),      0)::BIGINT AS total_fees_kobo,
         COALESCE(SUM(fl.soft_lock_kobo),       0)::BIGINT AS soft_lock_kobo,
         COALESCE(SUM(fl.total_collected_kobo - fl.total_fees_kobo - fl.total_paid_out_kobo - fl.soft_lock_kobo), 0)::BIGINT AS available_kobo,
         COALESCE(SUM(fl.member_count_paid),    0)::INT    AS member_count_paid,
         COALESCE(SUM(fl.total_transactions),   0)::INT    AS total_transactions
       FROM fund_types ft
       LEFT JOIN fund_ledger fl ON fl.fund_type_id = ft.id AND fl.period_month = $2
       WHERE ft.org_id = $1 AND ft.is_active = TRUE
       GROUP BY ft.id, ft.name, ft.kind, ft.is_shared_va, ft.is_anonymous_only
       ORDER BY ft.sort_order ASC`,
      [orgId, currentPeriod],
    );
  },

  /**
   * getSummary — high-level collection metrics.
   * Total collected, paid out, active members, pending payouts.
   */
  async getSummary(orgId: string): Promise<{
    total_collected_all_time_kobo: number;
    total_paid_out_all_time_kobo:  number;
    total_fees_all_time_kobo:      number;
    available_balance_kobo:        number;
    pending_payouts_kobo:          number;
    active_members:                number;
    total_transactions:            number;
    deficit_member_count:          number;
    period_month:                  string;
  }> {
    const currentPeriod = new Date().toISOString().slice(0, 7);

    const [ledger, members, pendingPayouts, deficitCount] = await Promise.all([
      queryOne<{
        total_collected: string;
        total_paid_out:  string;
        total_fees:      string;
        soft_lock:       string;
        tx_count:        string;
      }>(
        `SELECT
           COALESCE(SUM(total_collected_kobo), 0)::TEXT AS total_collected,
           COALESCE(SUM(total_paid_out_kobo),  0)::TEXT AS total_paid_out,
           COALESCE(SUM(total_fees_kobo),      0)::TEXT AS total_fees,
           COALESCE(SUM(soft_lock_kobo),       0)::TEXT AS soft_lock,
           COALESCE(SUM(total_transactions),   0)::TEXT AS tx_count
         FROM fund_ledger fl
         JOIN fund_types ft ON ft.id = fl.fund_type_id
         WHERE ft.org_id = $1`,
        [orgId],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM members WHERE org_id = $1 AND is_active = TRUE`,
        [orgId],
      ),
      queryOne<{ total_kobo: string }>(
        `SELECT COALESCE(SUM(amount_kobo), 0)::TEXT AS total_kobo
         FROM payout_requests
         WHERE org_id = $1 AND status IN ('PENDING','PARTIAL')`,
        [orgId],
      ),
      queryOne<{ deficit_count: string }>(
        `SELECT COUNT(DISTINCT m.id)::TEXT AS deficit_count
         FROM members m
         JOIN fund_types ft
           ON ft.org_id = $1 AND ft.is_active = TRUE AND ft.expected_amt_kobo IS NOT NULL
         LEFT JOIN member_fund_accounts mfa
           ON mfa.member_id = m.id AND mfa.fund_type_id = ft.id
         LEFT JOIN (
           SELECT member_fund_account_id,
                  COALESCE(SUM(amount_kobo), 0)::BIGINT AS paid_kobo
           FROM transactions WHERE period_month = $2
           GROUP BY member_fund_account_id
         ) t ON t.member_fund_account_id = mfa.id
         WHERE m.org_id = $1 AND m.is_active = TRUE
           AND COALESCE(t.paid_kobo, 0) < ft.expected_amt_kobo`,
        [orgId, currentPeriod],
      ),
    ]);

    const collected   = Number(ledger?.total_collected ?? 0);
    const paidOut     = Number(ledger?.total_paid_out  ?? 0);
    const fees        = Number(ledger?.total_fees      ?? 0);
    const softLock    = Number(ledger?.soft_lock       ?? 0);

    return {
      total_collected_all_time_kobo: collected,
      total_paid_out_all_time_kobo:  paidOut,
      total_fees_all_time_kobo:      fees,
      available_balance_kobo:        Math.max(0, collected - fees - paidOut - softLock),
      pending_payouts_kobo:          Number(pendingPayouts?.total_kobo ?? 0),
      active_members:                Number(members?.count ?? 0),
      total_transactions:            Number(ledger?.tx_count ?? 0),
      deficit_member_count:          Number(deficitCount?.deficit_count ?? 0),
      period_month:                  currentPeriod,
    };
  },

  /**
   * getMemberStatus — member payment status for a given period.
   * Shows: who paid, who hasn't, deficits, for admin oversight.
   */
  async getMemberStatus(orgId: string, period?: string): Promise<Array<{
    member_id:        string;
    member_name:      string;
    member_code:      string;
    fund_type_id:     string;
    fund_name:        string;
    total_paid_kobo:  number;
    expected_kobo:    number | null;
    deficit_kobo:     number;
    payment_status:   'PAID' | 'PARTIAL' | 'UNPAID';
    transaction_count: number;
  }>> {
    const currentPeriod = period ?? new Date().toISOString().slice(0, 7);

    return queryMany(
      `SELECT
         m.id              AS member_id,
         m.display_name    AS member_name,
         m.member_code,
         ft.id             AS fund_type_id,
         ft.name           AS fund_name,
         ft.expected_amt_kobo AS expected_kobo,
         COALESCE(SUM(t.amount_kobo), 0)::BIGINT  AS total_paid_kobo,
         COUNT(t.id)::INT                          AS transaction_count,
         CASE
           WHEN ft.expected_amt_kobo IS NULL THEN
             CASE WHEN COUNT(t.id) > 0 THEN 0 ELSE 0 END
           WHEN COALESCE(SUM(t.amount_kobo), 0) >= ft.expected_amt_kobo THEN 0
           ELSE ft.expected_amt_kobo - COALESCE(SUM(t.amount_kobo), 0)
         END::BIGINT AS deficit_kobo,
         CASE
           WHEN COUNT(t.id) = 0 THEN 'UNPAID'
           WHEN ft.expected_amt_kobo IS NOT NULL AND COALESCE(SUM(t.amount_kobo),0) < ft.expected_amt_kobo THEN 'PARTIAL'
           ELSE 'PAID'
         END AS payment_status
       FROM members m
       CROSS JOIN fund_types ft
       LEFT JOIN member_fund_accounts mfa
         ON mfa.member_id = m.id AND mfa.fund_type_id = ft.id
       LEFT JOIN transactions t
         ON t.member_fund_account_id = mfa.id AND t.period_month = $2
       WHERE m.org_id = $1 AND m.is_active = TRUE AND ft.org_id = $1 AND ft.is_active = TRUE
       GROUP BY m.id, m.display_name, m.member_code, ft.id, ft.name, ft.expected_amt_kobo
       HAVING COUNT(t.id) > 0 OR ft.expected_amt_kobo IS NOT NULL
       ORDER BY m.display_name ASC, ft.sort_order ASC`,
      [orgId, currentPeriod],
    );
  },

  /**
   * getPayoutHistory — recent payout requests with signatory details.
   */
  async getPayoutHistory(orgId: string, limit = 20): Promise<Array<{
    id:             string;
    fund_name:      string;
    amount_kobo:    number;
    purpose:        string;
    status:         string;
    initiated_by:   string;
    executed_at:    Date | null;
    created_at:     Date;
    bank_name:      string;
    account_number: string;
  }>> {
    return queryMany(
      `SELECT
         pr.id, ft.name AS fund_name, pr.amount_kobo, pr.purpose,
         pr.status, a.name AS initiated_by, pr.executed_at, pr.created_at,
         oba.bank_name, oba.account_number
       FROM payout_requests pr
       JOIN fund_types      ft  ON ft.id  = pr.fund_type_id
       JOIN admin_users     a   ON a.id   = pr.initiated_by
       JOIN org_bank_accounts oba ON oba.id = pr.bank_account_id
       WHERE pr.org_id = $1
       ORDER BY pr.created_at DESC
       LIMIT $2`,
      [orgId, limit],
    );
  },

  /**
   * getPeriodTrend — period-over-period collection totals for chart.
   */
  async getPeriodTrend(orgId: string, months = 6): Promise<Array<{
    period_month:         string;
    total_collected_kobo: number;
    total_paid_out_kobo:  number;
    transaction_count:    number;
  }>> {
    return queryMany(
      `SELECT
         fl.period_month,
         SUM(fl.total_collected_kobo)::BIGINT AS total_collected_kobo,
         SUM(fl.total_paid_out_kobo)::BIGINT  AS total_paid_out_kobo,
         SUM(fl.total_transactions)::INT      AS transaction_count
       FROM fund_ledger fl
       JOIN fund_types ft ON ft.id = fl.fund_type_id
       WHERE ft.org_id = $1
         AND fl.period_month >= TO_CHAR(NOW() - ($2 * INTERVAL '1 month'), 'YYYY-MM')
       GROUP BY fl.period_month
       ORDER BY fl.period_month ASC`,
      [orgId, months],
    );
  },

  /**
   * getActivity — recent audit_log rows for the activity feed.
   * metadata is self-contained (names, amounts) so no joins needed —
   * events stay renderable even if the referenced entity is deleted.
   */
  async getActivity(orgId: string, limit = 15): Promise<Array<{
    id:          string;
    actor_type:  string;
    actor_email: string | null;
    action:      string;
    entity_type: string;
    entity_id:   string | null;
    metadata:    Record<string, unknown> | null;
    created_at:  Date;
  }>> {
    return queryMany(
      `SELECT id, actor_type, actor_email, action,
              entity_type, entity_id, metadata, created_at
       FROM audit_log
       WHERE org_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [orgId, limit],
    );
  },
};