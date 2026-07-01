import { sharedFundVaRepository } from './shared-fund-va.repository';
import { vaNomba } from './va.nomba';
import { logger } from '../../utils/logger';
import { sharedVaReference } from '../../utils/generateRefrence';

/**
 * shared-fund-va.service.ts
 *
 * Get-or-create for funds marked is_shared_va — ONE VA for the whole org,
 * used by every member (or the public, for is_anonymous_only funds).
 * No per-member tracking: inflows are recorded as org+fund only.
 *
 * accountRef format: s_{30-char hex} — 32 chars, within Nomba's 16–64 limit.
 */

export interface SharedFundVA {
  va_number:         string;
  bank_name:         string;
  account_reference: string;
  isNew:             boolean;
}

export const sharedFundVaService = {
  async getOrCreateForOrgFund(
    orgId:       string,
    fundTypeId:  string,
    accountName: string,
  ): Promise<SharedFundVA> {
    const existing = await sharedFundVaRepository.findByOrgAndFund(orgId, fundTypeId);
    if (existing) {
      return {
        va_number:         existing.nomba_va_number,
        bank_name:         existing.bank_name,
        account_reference: existing.account_reference,
        isNew:             false,
      };
    }

    const accountRef = sharedVaReference(orgId, fundTypeId);

    logger.info({ org_id: orgId, fund_type_id: fundTypeId, account_ref: accountRef },
      '[SharedFundVA] Creating shared VA for fund');

    const nombaResult = await vaNomba.create({
      accountRef,
      accountName: accountName.slice(0, 64),
    });

    await sharedFundVaRepository.create({
      org_id:            orgId,
      fund_type_id:      fundTypeId,
      nomba_va_number:   nombaResult.vaNumber,
      nomba_va_id:       nombaResult.nombaVaId,
      account_reference: accountRef,
      bank_name:         nombaResult.bankName,
    });

    logger.info({ org_id: orgId, fund_type_id: fundTypeId, va_number: nombaResult.vaNumber },
      '[SharedFundVA] Shared VA created');

    return {
      va_number:         nombaResult.vaNumber,
      bank_name:         nombaResult.bankName,
      account_reference: accountRef,
      isNew:             true,
    };
  },
};
