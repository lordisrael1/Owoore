import { queryOne, queryMany } from '../../db';
import { toKobo } from '../../utils/kobo';

export interface FundType {
  id:               string;
  org_id:           string;
  name:             string;
  kind:             'RECURRING' | 'CAMPAIGN';
  description:      string | null;
  expected_amt_kobo: number | null;
  expires_at:       Date | null;
  is_active:        boolean;
  is_anonymous_only: boolean;
  sort_order:       number;
  created_at:       Date;
  updated_at:       Date;
}

export const fundRepository = {
  async create(input: {
    org_id:       string;
    name:         string;
    kind:         'RECURRING' | 'CAMPAIGN';
    description?: string;
    expected_amt?: number; // in naira — converted to kobo here
    expires_at?:   Date;
    sort_order:    number;
  }): Promise<FundType> {
    const expectedKobo = input.expected_amt ? toKobo(input.expected_amt) : null;

    const row = await queryOne<FundType>(
      `INSERT INTO fund_types
         (org_id, name, kind, description, expected_amt_kobo, expires_at, sort_order, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),NOW())
       RETURNING *`,
      [
        input.org_id, input.name, input.kind,
        input.description ?? null, expectedKobo,
        input.expires_at ?? null, input.sort_order,
      ],
    );
    return row!;
  },

  async findAllForOrg(org_id: string, activeOnly = true): Promise<FundType[]> {
    return queryMany<FundType>(
      `SELECT ft.*,
              ofa.nomba_va_number AS shared_va_number,
              ofa.bank_name       AS shared_va_bank
       FROM fund_types ft
       LEFT JOIN org_shared_fund_accounts ofa
         ON ofa.fund_type_id = ft.id AND ofa.org_id = ft.org_id
       WHERE ft.org_id = $1 AND ft.is_anonymous_only = FALSE ${activeOnly ? 'AND ft.is_active = TRUE' : ''}
       ORDER BY ft.sort_order ASC, ft.created_at ASC`,
      [org_id],
    );
  },

  async findById(id: string, org_id: string): Promise<FundType | null> {
    return queryOne<FundType>(
      `SELECT * FROM fund_types WHERE id = $1 AND org_id = $2`,
      [id, org_id],
    );
  },

  async update(id: string, org_id: string, fields: {
    name?:         string;
    description?:  string;
    expected_amt?: number; // naira
    expires_at?:   Date;
    sort_order?:   number;
    is_active?:    boolean;
    is_shared_va?: boolean;
  }): Promise<FundType | null> {
    const sets: string[]   = ['updated_at = NOW()'];
    const params: unknown[] = [id, org_id];

    if (fields.name !== undefined) {
      params.push(fields.name);
      sets.push(`name = $${params.length}`);
    }
    if (fields.description !== undefined) {
      params.push(fields.description);
      sets.push(`description = $${params.length}`);
    }
    if (fields.expected_amt !== undefined) {
      params.push(toKobo(fields.expected_amt));
      sets.push(`expected_amt_kobo = $${params.length}`);
    }
    if (fields.expires_at !== undefined) {
      params.push(fields.expires_at);
      sets.push(`expires_at = $${params.length}`);
    }
    if (fields.sort_order !== undefined) {
      params.push(fields.sort_order);
      sets.push(`sort_order = $${params.length}`);
    }
    if (fields.is_active !== undefined) {
      params.push(fields.is_active);
      sets.push(`is_active = $${params.length}`);
    }
    if (fields.is_shared_va !== undefined) {
      params.push(fields.is_shared_va);
      sets.push(`is_shared_va = $${params.length}`);
    }

    return queryOne<FundType>(
      `UPDATE fund_types SET ${sets.join(', ')}
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      params,
    );
  },

  async deactivate(id: string, org_id: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>(
      `UPDATE fund_types SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND org_id = $2 RETURNING id`,
      [id, org_id],
    );
    return row !== null;
  },

  // Find expired campaign funds — used by expiry.job.ts
  async findExpiredCampaigns(): Promise<FundType[]> {
    return queryMany<FundType>(
      `SELECT * FROM fund_types
       WHERE kind = 'CAMPAIGN' AND is_active = TRUE AND expires_at < NOW()`,
    );
  },
};