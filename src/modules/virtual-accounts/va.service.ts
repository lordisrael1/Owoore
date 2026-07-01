import { queryOne } from '../../db';
import { vaRepository } from './va.repository';
import { vaNomba } from './va.nomba';
import { vaReference } from '../../utils/generateRefrence';
import { sharedFundVaService } from './shared-fund-va.service';
import { Errors } from '../../utils/AppError';
import { logger } from '../../utils/logger';

/**
 * va.service.ts
 *
 * Get-or-create VA — the lazy creation pattern.
 *
 * Funds branch into two mechanisms based on fund_types.is_shared_va:
 *
 *   is_shared_va = FALSE (e.g. Tithe) — one VA PER MEMBER per fund.
 *     Created on-demand, stored in member_fund_accounts, fully tracked
 *     (deficit, pledge progress, personal giving history).
 *
 *   is_shared_va = TRUE (e.g. Offering) — one VA for the WHOLE ORG.
 *     Every member sees the same account number. No per-member tracking —
 *     inflows are recorded as org+fund only (same mechanism as the public
 *     Anonymous Giving fund), via shared-fund-va.service.ts.
 *
 * The accountReference for per-member VAs is the reconciliation backbone:
 *   format: member_{memberId}_fund_{fundTypeId}
 *   Every webhook lookup: accountRef → member + fund + org in one query.
 */
export const vaService = {
  /**
   * getOrCreate — the main VA endpoint.
   * Called when a member taps "Pay [Fund Name]" on the member portal.
   */
  async getOrCreate(
    memberId:   string,
    fundTypeId: string,
    orgId:      string,
  ): Promise<{
    vaNumber:        string;  // the NUBAN the member copies into their bank app
    bankName:        string;
    accountReference: string;
    isNew:           boolean;
  }> {
    // ── Fund lookup — always needed to know which VA mechanism applies ──
    const fund = await queryOne<{
      id: string; name: string; kind: string;
      expected_amt_kobo: number | null; expires_at: Date | null;
      is_active: boolean; is_shared_va: boolean;
    }>(
      `SELECT id, name, kind, expected_amt_kobo, expires_at, is_active, is_shared_va
       FROM fund_types WHERE id = $1 AND org_id = $2`,
      [fundTypeId, orgId],
    );

    if (!fund) throw Errors.notFound('Fund type');
    if (!fund.is_active) throw Errors.badRequest('This fund is no longer active.');

    // For CAMPAIGN funds: check it hasn't expired
    if (fund.kind === 'CAMPAIGN' && fund.expires_at && new Date() > new Date(fund.expires_at)) {
      throw Errors.badRequest(
        `The "${fund.name}" campaign ended on ${new Date(fund.expires_at).toLocaleDateString('en-NG')}. ` +
        'Contact your church admin for more information.',
      );
    }

    // ── Shared-VA funds (e.g. Offering): one VA for the whole org ───────
    if (fund.is_shared_va) {
      const org = await queryOne<{ name: string }>(`SELECT name FROM organisations WHERE id = $1`, [orgId]);
      const accountName = `${org?.name ?? 'Owoore'} — ${fund.name}`;

      const va = await sharedFundVaService.getOrCreateForOrgFund(orgId, fundTypeId, accountName);

      return {
        vaNumber:         va.va_number,
        bankName:         va.bank_name,
        accountReference: va.account_reference,
        isNew:            va.isNew,
      };
    }

    // ── Per-member VA funds (e.g. Tithe) ─────────────────────────────────
    const existing = await vaRepository.findByMemberAndFund(memberId, fundTypeId);

    if (existing) {
      logger.debug({
        member_id:    memberId,
        fund_type_id: fundTypeId,
        va_number:    existing.nomba_va_number,
      }, '[VAService] Returning existing VA (DB hit)');

      return {
        vaNumber:         existing.nomba_va_number,
        bankName:         existing.bank_name,
        accountReference: existing.account_reference,
        isNew:            false,
      };
    }

    const member = await queryOne<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM members WHERE id = $1 AND org_id = $2`,
      [memberId, orgId],
    );
    const org = await queryOne<{ name: string }>(`SELECT name FROM organisations WHERE id = $1`, [orgId]);

    if (!member) throw Errors.notFound('Member');
    if (!org)    throw Errors.notFound('Organisation');

    const accountRef  = vaReference(memberId, fundTypeId);
    // Account name format: "Bro Adebayo — Tithe — Grace Bible Church"
    const accountName = `${member.display_name} — ${fund.name} — ${org.name}`.slice(0, 100);

    const expiryDate  = fund.expires_at
      ? new Date(fund.expires_at).toISOString().slice(0, 10)
      : undefined;

    const expectedKobo = fund.expected_amt_kobo
      ? Number(fund.expected_amt_kobo)
      : undefined;

    logger.info({
      member_id:    memberId,
      fund_type_id: fundTypeId,
      account_ref:  accountRef,
      kind:         fund.kind,
      has_expiry:   !!expiryDate,
    }, '[VAService] Creating new VA via Nomba');

    const nombaResult = await vaNomba.create({
      accountRef,
      accountName,
      expiryDate,
      expectedKobo,
    });

    await vaRepository.create({
      member_id:         memberId,
      fund_type_id:      fundTypeId,
      org_id:            orgId,
      nomba_va_number:   nombaResult.vaNumber,
      nomba_va_id:       nombaResult.nombaVaId,
      account_reference: accountRef,
      bank_name:         nombaResult.bankName,
    });

    logger.info({
      member_id:    memberId,
      fund_type_id: fundTypeId,
      va_number:    nombaResult.vaNumber,
      bank:         nombaResult.bankName,
    }, '[VAService] New VA created and stored');

    return {
      vaNumber:         nombaResult.vaNumber,
      bankName:         nombaResult.bankName,
      accountReference: accountRef,
      isNew:            true,
    };
  },

  /**
   * getMemberVAs — returns all PERSONAL VAs a member has created.
   * Shared-fund VAs (e.g. Offering) never appear here since they aren't
   * tied to a member — see shared-fund-va.service.ts for those.
   */
  async getMemberVAs(memberId: string): Promise<Array<{
    fund_type_id:  string;
    fund_name:     string;
    va_number:     string;
    bank_name:     string;
    account_reference: string;
  }>> {
    const accounts = await vaRepository.findAllForMember(memberId);
    return accounts.map((a: any) => ({
      fund_type_id:      a.fund_type_id,
      fund_name:         a.fund_name,
      va_number:         a.nomba_va_number,
      bank_name:         a.bank_name,
      account_reference: a.account_reference,
    }));
  },
};
