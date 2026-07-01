import { queryOne, queryMany } from '../../db';

export interface MemberFundAccount {
  id:                string;
  member_id:         string;
  fund_type_id:      string;
  org_id:            string;
  nomba_va_number:   string;
  nomba_va_id:       string | null;
  account_reference: string;
  bank_name:         string;
  is_active:         boolean;
  created_at:        Date;
  updated_at:        Date;
}

export const vaRepository = {
  /**
   * findByReference — THE HOT PATH.
   *
   * Called on every single inbound webhook to resolve:
   *   accountReference → member_id + fund_type_id + org_id
   *
   * This query has a UNIQUE index on account_reference — O(1) lookup.
   * Zero ambiguity: one reference = one member + one fund.
   */
  async findByReference(accountReference: string): Promise<MemberFundAccount | null> {
    return queryOne<MemberFundAccount>(
      `SELECT * FROM member_fund_accounts WHERE account_reference = $1`,
      [accountReference],
    );
  },

  async findByMemberAndFund(
    memberId: string,
    fundTypeId: string,
  ): Promise<MemberFundAccount | null> {
    return queryOne<MemberFundAccount>(
      `SELECT * FROM member_fund_accounts
       WHERE member_id = $1 AND fund_type_id = $2 AND is_active = TRUE`,
      [memberId, fundTypeId],
    );
  },

  async findAllForMember(memberId: string): Promise<MemberFundAccount[]> {
    return queryMany<MemberFundAccount>(
      `SELECT mfa.*, ft.name AS fund_name, ft.kind
       FROM member_fund_accounts mfa
       JOIN fund_types ft ON ft.id = mfa.fund_type_id
       WHERE mfa.member_id = $1 AND mfa.is_active = TRUE
       ORDER BY mfa.created_at ASC`,
      [memberId],
    );
  },

  async create(input: {
    member_id:         string;
    fund_type_id:      string;
    org_id:            string;
    nomba_va_number:   string;
    nomba_va_id?:      string;
    account_reference: string;
    bank_name?:        string;
  }): Promise<MemberFundAccount> {
    const row = await queryOne<MemberFundAccount>(
      `INSERT INTO member_fund_accounts
         (member_id, fund_type_id, org_id, nomba_va_number, nomba_va_id,
          account_reference, bank_name, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),NOW())
       ON CONFLICT (member_id, fund_type_id) DO UPDATE
         SET updated_at = NOW()
       RETURNING *`,
      [
        input.member_id, input.fund_type_id, input.org_id,
        input.nomba_va_number, input.nomba_va_id ?? null,
        input.account_reference, input.bank_name ?? 'Providus Bank',
      ],
    );
    return row!;
  },
};