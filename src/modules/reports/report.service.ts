import { queryMany, queryOne } from '../../db';
import { fromKobo } from '../../utils/kobo';
import { formatNaira, formatPeriod } from '../../utils/formatMoney';
import { reconciliationService } from '../transactions/reconciliation.service';
import { Errors } from '../../utils/AppError';

/**
 * report.service.ts
 *
 * Aggregates data for downloadable reports.
 * Covers:
 *   - Org giving report by fund + period
 *   - Individual member giving statement
 *   - Arrears computation (members who owe across periods)
 */

export const reportService = {
  /**
   * getOrgGivingReport — aggregate by fund, period, member.
   * Powers GET /orgs/:id/reports/giving
   */
  async getOrgGivingReport(orgId: string, options: {
    period?:       string;
    fund_type_id?: string;
    year?:         number;
  }) {
    const targetYear  = options.year ?? new Date().getFullYear();
    const periodFilter = options.period ?? `${targetYear}-%`;

    // Fund-level totals
    const fundTotals = await queryMany<{
      fund_type_id:     string;
      fund_name:        string;
      period_month:     string;
      total_collected:  number;
      total_paid_out:   number;
      member_count:     number;
      tx_count:         number;
    }>(
      `SELECT
         ft.id   AS fund_type_id,
         ft.name AS fund_name,
         fl.period_month,
         fl.total_collected_kobo AS total_collected,
         fl.total_paid_out_kobo  AS total_paid_out,
         fl.member_count_paid    AS member_count,
         fl.total_transactions   AS tx_count
       FROM fund_ledger fl
       JOIN fund_types ft ON ft.id = fl.fund_type_id
       WHERE ft.org_id = $1
         AND fl.period_month LIKE $2
         ${options.fund_type_id ? 'AND fl.fund_type_id = $3' : ''}
       ORDER BY ft.sort_order ASC, fl.period_month ASC`,
      options.fund_type_id
        ? [orgId, `${targetYear}-%`, options.fund_type_id]
        : [orgId, `${targetYear}-%`],
    );

    // Arrears — members with outstanding balances
    const arrears = await this.computeArrears(orgId);

    return {
      year:        targetYear,
      period:      options.period,
      fund_totals: fundTotals.map((f) => ({
        ...f,
        collected_display: formatNaira(Number(f.total_collected)),
        period_display:    formatPeriod(f.period_month),
      })),
      arrears_summary: {
        members_with_deficit: arrears.filter((a) => a.total_deficit_kobo > 0).length,
        total_deficit_kobo:   arrears.reduce((sum, a) => sum + a.total_deficit_kobo, 0),
      },
    };
  },

  /**
   * getMemberStatement — full giving history for one member.
   * Powers GET /members/:id/statement
   */
  async getMemberStatement(memberId: string, orgId: string, year?: number) {
    const targetYear = year ?? new Date().getFullYear();

    // Verify member belongs to org
    const member = await queryOne<{
      id: string; display_name: string; member_code: string; email: string; joined_at: Date;
    }>(
      `SELECT id, display_name, member_code, email, joined_at
       FROM members WHERE id = $1 AND org_id = $2 AND is_active = TRUE`,
      [memberId, orgId],
    );
    if (!member) throw Errors.notFound('Member');

    // All transactions for the year
    const transactions = await queryMany<{
      fund_name:      string;
      period_month:   string;
      amount_kobo:    number;
      payment_status: string;
      variance_kobo:  number;
      created_at:     Date;
    }>(
      `SELECT
         ft.name AS fund_name,
         t.period_month, t.amount_kobo, t.payment_status,
         t.variance_kobo, t.created_at
       FROM transactions t
       JOIN fund_types ft ON ft.id = t.fund_type_id
       WHERE t.member_id = $1 AND t.period_month LIKE $2
       ORDER BY t.created_at DESC`,
      [memberId, `${targetYear}-%`],
    );

    // Per-fund summary with pledge progress
    const fundSummary = await queryMany<{
      fund_name:         string;
      fund_type_id:      string;
      expected_amt_kobo: number | null;
      total_paid_kobo:   number;
    }>(
      `SELECT
         ft.name AS fund_name, ft.id AS fund_type_id,
         ft.expected_amt_kobo,
         COALESCE(SUM(t.amount_kobo), 0)::BIGINT AS total_paid_kobo
       FROM fund_types ft
       LEFT JOIN member_fund_accounts mfa
         ON mfa.fund_type_id = ft.id AND mfa.member_id = $1
       LEFT JOIN transactions t
         ON t.member_fund_account_id = mfa.id AND t.period_month LIKE $2
       WHERE ft.org_id = $3 AND ft.is_active = TRUE
       GROUP BY ft.id, ft.name, ft.expected_amt_kobo
       ORDER BY ft.sort_order ASC`,
      [memberId, `${targetYear}-%`, orgId],
    );

    const totalPaid = transactions.reduce((sum, t) => sum + Number(t.amount_kobo), 0);

    return {
      member: {
        id:          member.id,
        name:        member.display_name,
        member_code: member.member_code,
        joined_at:   member.joined_at,
      },
      year: targetYear,
      total_paid_kobo:    totalPaid,
      total_paid_display: formatNaira(totalPaid),
      fund_summary: fundSummary.map((f) => {
        const paid    = Number(f.total_paid_kobo);
        const expKobo = f.expected_amt_kobo ? Number(f.expected_amt_kobo) : null;
        return {
          fund_name:           f.fund_name,
          total_paid_kobo:     paid,
          total_paid_display:  formatNaira(paid),
          expected_kobo:       expKobo,
          expected_display:    expKobo ? formatNaira(expKobo) : null,
          pledge_progress_pct: expKobo
            ? reconciliationService.computePledgeProgress(paid, expKobo)
            : 100,
          deficit_kobo: expKobo
            ? reconciliationService.computeRunningDeficit(paid, expKobo)
            : 0,
        };
      }),
      transactions: transactions.map((t) => ({
        ...t,
        amount_display: formatNaira(Number(t.amount_kobo)),
        period_display: formatPeriod(t.period_month),
      })),
    };
  },

  /**
   * computeArrears — members with outstanding balances across all active funds.
   * Used in org report and reminder.job.ts.
   */
  async computeArrears(orgId: string): Promise<Array<{
    member_id:          string;
    member_name:        string;
    member_code:        string;
    email:              string;
    total_deficit_kobo: number;
    funds:              Array<{ fund_name: string; deficit_kobo: number }>;
  }>> {
    const rows = await queryMany<{
      member_id:        string;
      member_name:      string;
      member_code:      string;
      email:            string;
      fund_type_id:     string;
      fund_name:        string;
      expected_amt_kobo: number;
      total_paid_kobo:  number;
    }>(
      `SELECT
         m.id   AS member_id,
         m.display_name AS member_name,
         m.member_code,
         m.email,
         ft.id   AS fund_type_id,
         ft.name AS fund_name,
         ft.expected_amt_kobo,
         COALESCE(SUM(t.amount_kobo), 0)::BIGINT AS total_paid_kobo
       FROM members m
       CROSS JOIN fund_types ft
       LEFT JOIN member_fund_accounts mfa
         ON mfa.member_id = m.id AND mfa.fund_type_id = ft.id
       LEFT JOIN transactions t ON t.member_fund_account_id = mfa.id
       WHERE m.org_id = $1 AND m.is_active = TRUE
         AND ft.org_id = $1 AND ft.is_active = TRUE
         AND ft.expected_amt_kobo IS NOT NULL
         AND ft.expected_amt_kobo > 0
       GROUP BY m.id, m.display_name, m.member_code, m.email,
                ft.id, ft.name, ft.expected_amt_kobo
       HAVING COALESCE(SUM(t.amount_kobo), 0) < ft.expected_amt_kobo`,
      [orgId],
    );

    // Group by member
    const memberMap = new Map<string, typeof rows[0] & {
      total_deficit_kobo: number;
      funds: Array<{ fund_name: string; deficit_kobo: number }>;
    }>();

    for (const row of rows) {
      const deficit = Number(row.expected_amt_kobo) - Number(row.total_paid_kobo);
      if (!memberMap.has(row.member_id)) {
        memberMap.set(row.member_id, {
          ...row, total_deficit_kobo: 0, funds: [],
        });
      }
      const m = memberMap.get(row.member_id)!;
      m.total_deficit_kobo += deficit;
      m.funds.push({ fund_name: row.fund_name, deficit_kobo: deficit });
    }

    return Array.from(memberMap.values())
      .sort((a, b) => b.total_deficit_kobo - a.total_deficit_kobo);
  },
};