import { queryOne } from '../../db';

export interface OrgSharedFundAccount {
  id:                string;
  org_id:            string;
  fund_type_id:      string;
  nomba_va_number:   string;
  nomba_va_id:       string | null;
  account_reference: string;
  bank_name:         string;
  is_active:         boolean;
  created_at:        Date;
  updated_at:        Date;
}

export const sharedFundVaRepository = {
  async findByOrgAndFund(orgId: string, fundTypeId: string): Promise<OrgSharedFundAccount | null> {
    return queryOne<OrgSharedFundAccount>(
      `SELECT * FROM org_shared_fund_accounts WHERE org_id = $1 AND fund_type_id = $2`,
      [orgId, fundTypeId],
    );
  },

  async create(input: {
    org_id:            string;
    fund_type_id:      string;
    nomba_va_number:   string;
    nomba_va_id?:      string;
    account_reference: string;
    bank_name?:        string;
  }): Promise<OrgSharedFundAccount> {
    const row = await queryOne<OrgSharedFundAccount>(
      `INSERT INTO org_shared_fund_accounts
         (org_id, fund_type_id, nomba_va_number, nomba_va_id, account_reference, bank_name, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW(),NOW())
       ON CONFLICT (org_id, fund_type_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [
        input.org_id, input.fund_type_id, input.nomba_va_number,
        input.nomba_va_id ?? null, input.account_reference,
        input.bank_name ?? 'Providus Bank',
      ],
    );
    return row!;
  },
};
