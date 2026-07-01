import { memberRepository } from './member.repository';
import { reconciliationService } from '../transactions/reconciliation.service';
import { fromKobo } from '../../utils/kobo';

/**
 * member-ledger.service.ts
 *
 * Per-member per-fund running balance, deficit calculation, pledge progress.
 *
 * Used by:
 *   - Member portal (/me) — show contribution summary per fund
 *   - Admin dashboard — member-level giving report
 *   - Reconciliation engine — compute deficit after each payment
 */

export interface MemberFundSummary {
  fund_type_id:       string;
  fund_name:          string;
  kind:               'RECURRING' | 'CAMPAIGN';
  total_paid_kobo:    number;
  total_paid_naira:   number;
  expected_amt_kobo:  number | null;
  expected_amt_naira: number | null;
  deficit_kobo:       number;
  deficit_naira:      number;
  surplus_kobo:       number;
  pledge_progress_pct: number;
  transaction_count:  number;
  last_paid_at:       Date | null;
  is_fulfilled:       boolean;
}

export const memberLedgerService = {
  /**
   * getMemberFundSummaries — returns per-fund contribution summary for a member.
   *
   * For each fund the member has a VA for:
   *   - total amount paid (all time)
   *   - deficit / surplus vs expected amount
   *   - pledge progress percentage (0-100)
   *   - whether the pledge is fulfilled
   *
   * This drives the member portal dashboard and the admin member detail view.
   */
  async getMemberFundSummaries(memberId: string): Promise<MemberFundSummary[]> {
    const rows = await memberRepository.getFundSummary(memberId);

    return rows.map((row) => {
      const totalPaid      = Number(row.total_paid_kobo);
      const expectedKobo   = row.expected_amt_kobo ? Number(row.expected_amt_kobo) : null;

      const reconciliation = reconciliationService.reconcile({
        amountKobo:      totalPaid,      // running total
        expectedAmtKobo: expectedKobo,
      });

      const pledgeProgress = expectedKobo
        ? reconciliationService.computePledgeProgress(totalPaid, expectedKobo)
        : 100; // No pledge = always 100%

      const deficit = expectedKobo
        ? reconciliationService.computeRunningDeficit(totalPaid, expectedKobo)
        : 0;

      return {
        fund_type_id:        row.fund_type_id,
        fund_name:           row.fund_name,
        kind:                row.kind as 'RECURRING' | 'CAMPAIGN',
        total_paid_kobo:     totalPaid,
        total_paid_naira:    fromKobo(totalPaid),
        expected_amt_kobo:   expectedKobo,
        expected_amt_naira:  expectedKobo ? fromKobo(expectedKobo) : null,
        deficit_kobo:        deficit,
        deficit_naira:       fromKobo(deficit),
        surplus_kobo:        reconciliation.surplusKobo,
        pledge_progress_pct: pledgeProgress,
        transaction_count:   Number(row.transaction_count),
        last_paid_at:        row.last_paid_at,
        is_fulfilled:        expectedKobo ? totalPaid >= expectedKobo : true,
      };
    });
  },

  /**
   * getMemberDeficit — returns the outstanding balance for a specific fund.
   * Used in the underpayment SMS: "Balance remaining: ₦20,000"
   */
  async getMemberDeficit(memberId: string, fundTypeId: string): Promise<{
    deficit_kobo:        number;
    total_paid_kobo:     number;
    expected_amt_kobo:   number | null;
    pledge_progress_pct: number;
  }> {
    const summaries = await this.getMemberFundSummaries(memberId);
    const fund      = summaries.find((s) => s.fund_type_id === fundTypeId);

    if (!fund) {
      return {
        deficit_kobo:        0,
        total_paid_kobo:     0,
        expected_amt_kobo:   null,
        pledge_progress_pct: 100,
      };
    }

    return {
      deficit_kobo:        fund.deficit_kobo,
      total_paid_kobo:     fund.total_paid_kobo,
      expected_amt_kobo:   fund.expected_amt_kobo,
      pledge_progress_pct: fund.pledge_progress_pct,
    };
  },
};