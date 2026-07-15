import { queryOne, queryMany } from '../../db';

export interface Member {
  id:           string;
  org_id:       string;
  email:        string;
  display_name: string;
  member_code:  string;
  is_active:    boolean;
  joined_at:    Date;
  updated_at:   Date;
}

export const memberRepository = {
  async findByEmailAndOrg(email: string, org_id: string): Promise<Member | null> {
    return queryOne<Member>(
      `SELECT * FROM members WHERE email = $1 AND org_id = $2 AND is_active = TRUE`,
      [email, org_id],
    );
  },

  async findById(id: string, org_id: string): Promise<Member | null> {
    return queryOne<Member>(
      `SELECT * FROM members WHERE id = $1 AND org_id = $2`,
      [id, org_id],
    );
  },

  async listForOrg(org_id: string, limit = 50, offset = 0): Promise<Member[]> {
    return queryMany<Member>(
      `SELECT * FROM members WHERE org_id = $1 AND is_active = TRUE
       ORDER BY joined_at DESC LIMIT $2 OFFSET $3`,
      [org_id, limit, offset],
    );
  },

  async countForOrg(org_id: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM members WHERE org_id = $1`,
      [org_id],
    );
    return Number(row?.count ?? 0);
  },

  async upsert(input: {
    org_id:       string;
    email:        string;
    display_name: string;
    member_code:  string;
  }): Promise<{ member: Member; isNew: boolean }> {
    // Try to find existing
    const existing = await this.findByEmailAndOrg(input.email, input.org_id);
    if (existing) return { member: existing, isNew: false };

    // Create new
    const row = await queryOne<Member>(
      `INSERT INTO members (org_id, email, display_name, member_code, is_active, joined_at, updated_at)
       VALUES ($1,$2,$3,$4,TRUE,NOW(),NOW())
       ON CONFLICT (org_id, email) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [input.org_id, input.email, input.display_name, input.member_code],
    );
    return { member: row!, isNew: true };
  },

  // Giving history — all transactions for a member with optional filters
  async getGivingHistory(memberId: string, filters: {
    fund_type_id?: string;
    period?:       string;
    limit:         number;
    offset:        number;
  }): Promise<Array<{
    id:             string;
    amount_kobo:    number;
    payment_status: string;
    variance_kobo:  number;
    fund_name:      string;
    period_month:   string;
    created_at:     Date;
    sender_name:    string | null;
    narration:      string | null;
  }>> {
    const conditions  = ['t.member_id = $1'];
    const params: unknown[] = [memberId];

    if (filters.fund_type_id) {
      params.push(filters.fund_type_id);
      conditions.push(`t.fund_type_id = $${params.length}`);
    }
    if (filters.period) {
      params.push(filters.period);
      conditions.push(`t.period_month = $${params.length}`);
    }

    params.push(filters.limit, filters.offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    return queryMany(
      `SELECT
         t.id, t.amount_kobo, t.payment_status, t.variance_kobo,
         ft.name AS fund_name, t.period_month, t.created_at,
         t.sender_name, t.narration
       FROM transactions t
       JOIN fund_types ft ON ft.id = t.fund_type_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
  },

  // Per-fund summary for the member portal dashboard
  async getFundSummary(memberId: string): Promise<Array<{
    fund_type_id:     string;
    fund_name:        string;
    kind:             string;
    total_paid_kobo:  number;
    expected_amt_kobo: number | null;
    transaction_count: number;
    last_paid_at:     Date | null;
  }>> {
    return queryMany(
      `SELECT
         ft.id   AS fund_type_id,
         ft.name AS fund_name,
         ft.kind,
         ft.expected_amt_kobo,
         COALESCE(SUM(t.amount_kobo), 0)::BIGINT AS total_paid_kobo,
         COUNT(t.id)::INT                         AS transaction_count,
         MAX(t.created_at)                        AS last_paid_at
       FROM member_fund_accounts mfa
       JOIN fund_types ft ON ft.id = mfa.fund_type_id
       LEFT JOIN transactions t ON t.member_fund_account_id = mfa.id
       WHERE mfa.member_id = $1 AND ft.is_active = TRUE
       GROUP BY ft.id, ft.name, ft.kind, ft.expected_amt_kobo
       ORDER BY ft.sort_order ASC`,
      [memberId],
    );
  },
};