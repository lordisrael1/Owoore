import { queryOne } from '../../db';
import { logger } from '../../utils/logger';
import { lookupBankAccount } from './bank-lookup.service';

/**
 * bank-account.service.ts
 *
 * Resolves a typed-in (bankCode, accountNumber) pair into an
 * org_bank_accounts row, so payouts can go to any recipient the admin
 * types in — not just accounts pre-registered in Settings.
 *
 * The account is always re-verified against Nomba (never trust a
 * client-supplied name) before it's reused or persisted. Saved as a
 * general-purpose entry (fund_type_id = NULL) since it's a one-off
 * payout recipient, not a fund's configured sweep destination.
 */

export interface ResolvedBankAccount {
  id:             string;
  bank_code:      string;
  bank_name:      string;
  account_number: string;
  account_name:   string;
}

export async function findOrCreateOrgBankAccount(params: {
  orgId:         string;
  bankCode:      string;
  accountNumber: string;
}): Promise<ResolvedBankAccount> {
  const { orgId, bankCode, accountNumber } = params;

  const lookup = await lookupBankAccount(bankCode, accountNumber);

  const existing = await queryOne<ResolvedBankAccount>(
    `SELECT id, bank_code, bank_name, account_number, account_name
     FROM org_bank_accounts
     WHERE org_id = $1 AND bank_code = $2 AND account_number = $3`,
    [orgId, bankCode, accountNumber],
  );

  if (existing) {
    if (existing.account_name !== lookup.accountName) {
      await queryOne(
        `UPDATE org_bank_accounts
         SET account_name = $1, is_verified = TRUE, updated_at = NOW()
         WHERE id = $2`,
        [lookup.accountName, existing.id],
      );
    }
    return { ...existing, account_name: lookup.accountName, bank_name: lookup.bankName };
  }

  const created = await queryOne<ResolvedBankAccount>(
    `INSERT INTO org_bank_accounts
       (org_id, fund_type_id, label, bank_code, bank_name, account_number,
        account_name, is_verified, is_default, is_active)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, TRUE, FALSE, TRUE)
     RETURNING id, bank_code, bank_name, account_number, account_name`,
    [orgId, lookup.accountName, bankCode, lookup.bankName, accountNumber, lookup.accountName],
  );

  logger.info({ org_id: orgId, bank_account_id: created!.id },
    '[BankAccountService] Verified and saved new payout recipient');

  return created!;
}
