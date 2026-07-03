import { queryOne, queryMany } from '../../db';
import { memberRepository } from './member.repository';
import { memberLedgerService } from './member-ledger.service';
import { Errors } from '../../utils/AppError';
import { env } from '../../config/env';
import { getOrSetWithLock } from '../../utils/cacheAside';

interface OrgPortalMeta {
  org: { name: string; slug: string; logo_url: string | null } | null;
  fundTypes: Array<{
    id: string; name: string; kind: string;
    expected_amt_kobo: number | null; expires_at: Date | null; sort_order: number;
    is_shared_va: boolean;
  }>;
}

/**
 * getOrgPortalMeta — org profile + active fund cards shown on the member
 * portal. Identical for every member of the same church, unlike the rest
 * of GET /me (member row, fund summaries) which is per-member and must
 * stay instantly fresh. Cached under org_id — that's the key many
 * concurrent members actually share, not member_id.
 */
async function getOrgPortalMeta(orgId: string): Promise<OrgPortalMeta> {
  return getOrSetWithLock<OrgPortalMeta>({
    key:        `org:${orgId}:portal-meta`,
    ttlSeconds: 120,
    fetch: async () => {
      const org = await queryOne<{ name: string; slug: string; logo_url: string | null }>(
        `SELECT name, slug, logo_url FROM organisations WHERE id = $1`,
        [orgId],
      );

      // is_shared_va: fund uses one org-wide VA (e.g. Offering) — frontend
      // should hide personal giving history/pledge progress for these.
      const fundTypes = await queryMany<{
        id: string; name: string; kind: string;
        expected_amt_kobo: number | null; expires_at: Date | null; sort_order: number;
        is_shared_va: boolean;
      }>(
        `SELECT id, name, kind, expected_amt_kobo, expires_at, sort_order, is_shared_va
         FROM fund_types
         WHERE org_id = $1 AND is_active = TRUE AND is_anonymous_only = FALSE
         ORDER BY sort_order ASC`,
        [orgId],
      );

      return { org, fundTypes };
    },
  });
}

/**
 * member.service.ts
 *
 * Self-onboarding via org slug, find-or-create by email + org.
 *
 * The member flow:
 *   1. Member taps: owoore.ng/join/{slug}
 *   2. Frontend calls GET /orgs/{slug} → gets org name + logo (no auth)
 *   3. Member enters email → POST /auth/send-otp
 *   4. Member enters code  → POST /auth/verify-otp → JWT issued, member created
 *   5. Member sees fund cards → taps a fund → POST /me/funds/:fundId/account
 *   6. Member copies VA number → pays in their banking app
 *   7. Webhook fires → member gets email confirmation
 *
 * This service handles step 5 onwards — the member is authenticated
 * (JWT verified by authenticateMember middleware) before reaching here.
 */

export const memberService = {
  /**
   * getProfile — returns authenticated member's profile + fund summaries.
   * Called by GET /me.
   */
  async getProfile(memberId: string, orgId: string) {
    const member = await memberRepository.findById(memberId, orgId);
    if (!member) throw Errors.notFound('Member profile');

    // Org profile + fund cards — identical for every member of this church,
    // so this is cached (cache-aside + stampede lock) keyed by org_id.
    const { org, fundTypes } = await getOrgPortalMeta(orgId);

    // Per-fund giving summaries (pledge progress, deficit etc.) — must stay
    // instantly fresh (a member expects /me to reflect a payment the moment
    // it lands), so this is never cached.
    const fundSummaries = await memberLedgerService.getMemberFundSummaries(memberId);

    return {
      member: {
        id:          member.id,
        name:        member.display_name,
        email:       member.email,
        memberCode:  member.member_code,
        joinedAt:    member.joined_at,
      },
      org: {
        name:     org?.name,
        slug:     org?.slug,
        logo_url: org?.logo_url,
        joinLink: `${env.APP_BASE_URL}/join/${org?.slug}`,
      },
      fundTypes,
      fundSummaries,
    };
  },

  /**
   * getGivingHistory — member's transaction history with optional filters.
   * Called by GET /me/giving-history.
   */
  async getGivingHistory(memberId: string, filters: {
    fund_type_id?: string;
    period?:       string;
    limit:         number;
    offset:        number;
  }) {
    const history = await memberRepository.getGivingHistory(memberId, filters);
    return history;
  },

  /**
   * listForAdmin — paginated member list for the admin dashboard.
   * Includes fund summary per member.
   */
  async listForAdmin(orgId: string, limit = 50, offset = 0) {
    const members = await memberRepository.listForOrg(orgId, limit, offset);
    const total   = await memberRepository.countForOrg(orgId);
    return { members, total, limit, offset };
  },
};