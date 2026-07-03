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

  /**
   * getActivity — audit_log rows shaped for the <ActivityFeed> component:
   * { id, type, title, desc, time }. Rendering strings are built here so
   * the frontend stays a dumb list.
   */
  async getActivity(orgId: string, limit = 15) {
    const rows = await dashboardRepository.getActivity(orgId, limit);

    return rows.map((row) => {
      const m = (row.metadata ?? {}) as Record<string, any>;
      const naira = (kobo: unknown) => formatNaira(Number(kobo ?? 0));

      let type: 'payment' | 'payout' | 'member' | 'campaign' | 'system' = 'system';
      let title = row.action.replace(/_/g, ' ').toLowerCase();
      let desc  = row.actor_email ?? '';

      switch (row.action) {
        case 'PAYMENT_RECEIVED':
          type  = 'payment';
          title = `${m.member_name ?? 'A member'} paid ${naira(m.amount_kobo)}`;
          desc  = `${m.fund_name ?? 'Fund'}${m.payment_status && m.payment_status !== 'EXACT' ? ` · ${m.payment_status}` : ''}`;
          break;
        case 'ANONYMOUS_PAYMENT_RECEIVED':
          type  = 'payment';
          title = `Anonymous gift of ${naira(m.amount_kobo)}`;
          desc  = m.fund_name ?? 'Shared fund';
          break;
        case 'MEMBER_JOINED':
          type  = 'member';
          title = `${m.display_name ?? 'A member'} joined`;
          desc  = `Member ${m.member_code ?? ''} registered via join link`;
          break;
        case 'FUND_CREATED':
          type  = 'campaign';
          title = `Fund created: ${m.fund_name ?? ''}`;
          desc  = `${m.kind ?? ''}${row.actor_email ? ` · by ${row.actor_email}` : ''}`;
          break;
        case 'PAYOUT_INITIATED':
          type  = 'payout';
          title = `Payout of ${naira(m.amount_kobo)} initiated`;
          desc  = m.purpose ?? '';
          break;
        case 'PAYOUT_APPROVAL_RECORDED':
          type  = 'payout';
          title = `Payout approval ${m.approvals_in ?? '?'} of ${m.approvals_needed ?? '?'} recorded`;
          desc  = `${m.signatory_name ?? 'A signatory'} approved · ${naira(m.amount_kobo)}`;
          break;
        case 'PAYOUT_APPROVED':
          type  = 'payout';
          title = `Payout of ${naira(m.amount_kobo)} fully approved`;
          desc  = `Quorum reached · ${m.purpose ?? ''}`;
          break;
        case 'PAYOUT_DECLINED':
          type  = 'payout';
          title = `Payout declined by ${m.signatory_name ?? 'a signatory'}`;
          desc  = `${naira(m.amount_kobo)} unlocked · ${m.purpose ?? ''}`;
          break;
        case 'PAYOUT_TRANSFERRED':
          type  = 'payout';
          title = `${naira(m.amount_kobo)} transferred to bank`;
          desc  = m.purpose ?? 'Transfer settled by Nomba';
          break;
        case 'PAYOUT_TRANSFER_FAILED':
          type  = 'payout';
          title = `Payout transfer failed`;
          desc  = `${naira(m.amount_kobo)} back in balance · ${m.reason ?? ''}`;
          break;
        case 'ADMIN_INVITED':
          type  = 'member';
          title = `${m.invitee_name ?? 'A teammate'} invited as ${m.role ?? 'TREASURER'}`;
          desc  = m.invitee_email ?? '';
          break;
      }

      return {
        id:    row.id,
        type,
        title,
        desc,
        time:  row.created_at,
        action: row.action,
      };
    });
  },
};