import { sharedFundVaService } from './shared-fund-va.service';
import { logger } from '../../utils/logger';
import { queryOne } from '../../db';

/**
 * anonymous-va.service.ts
 *
 * The public-facing entry point for anonymous giving: lazily creates a
 * dedicated "Anonymous Giving" fund (is_anonymous_only = TRUE, implies
 * is_shared_va = TRUE), then delegates VA creation to shared-fund-va.service.ts
 * — the same mechanism used by member-portal shared funds like Offering.
 */

export interface AnonymousVA {
  va_number:         string;
  bank_name:         string;
  account_reference: string;
}

const ANONYMOUS_FUND_NAME = 'Anonymous Giving';

export const anonymousVaService = {
  async getOrCreateForOrg(orgId: string): Promise<AnonymousVA> {
    const org = await queryOne<{ name: string }>(`SELECT name FROM organisations WHERE id = $1`, [orgId]);
    const orgName = org?.name ?? 'Owoore';

    const fundId = await this.getOrCreateAnonymousFund(orgId);

    const va = await sharedFundVaService.getOrCreateForOrgFund(
      orgId,
      fundId,
      `${orgName} - Anonymous Giving`,
    );

    return {
      va_number:         va.va_number,
      bank_name:         va.bank_name,
      account_reference: va.account_reference,
    };
  },

  /**
   * getOrCreateAnonymousFund — lazily creates the dedicated "Anonymous Giving"
   * fund for this org, on first use. One per org, never duplicated.
   */
  async getOrCreateAnonymousFund(orgId: string): Promise<string> {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM fund_types WHERE org_id = $1 AND is_anonymous_only = TRUE`,
      [orgId],
    );
    if (existing) return existing.id;

    const created = await queryOne<{ id: string }>(
      `INSERT INTO fund_types (org_id, name, kind, sort_order, is_active, is_anonymous_only, is_shared_va, created_at, updated_at)
       VALUES ($1, $2, 'RECURRING', 0, TRUE, TRUE, TRUE, NOW(), NOW())
       RETURNING id`,
      [orgId, ANONYMOUS_FUND_NAME],
    );

    logger.info({ org_id: orgId, fund_id: created!.id },
      '[AnonymousVA] Created dedicated Anonymous Giving fund');

    return created!.id;
  },
};
