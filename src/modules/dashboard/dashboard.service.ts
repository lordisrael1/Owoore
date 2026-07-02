import { dashboardRepository } from './dashboard.repository';
import { fromKobo } from '../../utils/kobo';
import { formatNaira } from '../../utils/formatMoney';

/**
 * dashboard.service.ts
 *
 * Aggregates and enriches dashboard data for the admin frontend.
 * Adds naira display values alongside kobo raw values.
 * Computes collection rates and trends.
 */

export const dashboardService = {
  /**
   * getSummary — top-level metrics shown on the dashboard home.
   */
  async getSummary(orgId: string) {
    const raw = await dashboardRepository.getSummary(orgId);
    const trend = await dashboardRepository.getPeriodTrend(orgId, 6);

    return {
      ...raw,
      // Naira display values for the frontend
      total_collected_display: formatNaira(raw.total_collected_all_time_kobo),
      available_display:       formatNaira(raw.available_balance_kobo),
      pending_payouts_display: formatNaira(raw.pending_payouts_kobo),
      deficit_member_count:    raw.deficit_member_count,
      // Collection rate this month vs last month
      trend: trend.map((t) => ({
        ...t,
        collected_display: formatNaira(Number(t.total_collected_kobo)),
      })),
    };
  },

  /**
   * getFundBreakdown — per-fund balance panel.
   */
  async getFundBreakdown(orgId: string, period?: string) {
    const funds = await dashboardRepository.getFundBreakdown(orgId, period);

    return funds.map((f) => ({
      ...f,
      available_kobo: Math.max(
        0,
        Number(f.total_collected_kobo) - Number(f.total_paid_out_kobo) - Number(f.soft_lock_kobo),
      ),
      // Display values
      collected_display: formatNaira(Number(f.total_collected_kobo)),
      available_display: formatNaira(
        Math.max(0, Number(f.total_collected_kobo) - Number(f.total_paid_out_kobo) - Number(f.soft_lock_kobo)),
      ),
    }));
  },

  /**
   * getMemberStatus — who paid, who hasn't, deficit amounts.
   * Powers the "Members" tab on the admin dashboard.
   */
  async getMemberStatus(orgId: string, period?: string) {
    const rows = await dashboardRepository.getMemberStatus(orgId, period);

    return rows.map((r) => ({
      ...r,
      total_paid_display: formatNaira(Number(r.total_paid_kobo)),
      expected_display:   r.expected_kobo ? formatNaira(Number(r.expected_kobo)) : null,
      deficit_display:    Number(r.deficit_kobo) > 0 ? formatNaira(Number(r.deficit_kobo)) : null,
    }));
  },

  /**
   * getPayoutHistory — recent payout list for the treasury tab.
   */
  async getPayoutHistory(orgId: string, limit = 20) {
    const payouts = await dashboardRepository.getPayoutHistory(orgId, limit);

    return payouts.map((p) => ({
      ...p,
      amount_display: formatNaira(Number(p.amount_kobo)),
    }));
  },
};