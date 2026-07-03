import { query, queryOne, queryMany, withTransaction } from '../../db';
import { PayoutStatus } from './payout-state.machine';

/**
 * payout.repository.ts — all DB access for payout_requests table.
 */

export interface PayoutRequest {
  id:                 string;
  org_id:             string;
  fund_type_id:       string;
  bank_account_id:    string;
  initiated_by:       string;
  amount_kobo:        number;
  purpose:            string;
  status:             PayoutStatus;
  nomba_transfer_ref: string | null;
  nomba_transfer_id:  string | null;
  transfer_error:     string | null;
  approvals_received: number;
  declined_by:        string | null;
  executed_at:        Date   | null;
  expires_at:         Date;
  created_at:         Date;
  updated_at:         Date;
}

export const payoutRepository = {
  async create(input: {
    org_id:          string;
    fund_type_id:    string;
    bank_account_id: string;
    initiated_by:    string;
    amount_kobo:     number;
    purpose:         string;
    expires_at:      Date;
  }): Promise<PayoutRequest> {
    const row = await queryOne<PayoutRequest>(
      `INSERT INTO payout_requests
         (org_id, fund_type_id, bank_account_id, initiated_by,
          amount_kobo, purpose, status, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,NOW(),NOW())
       RETURNING *`,
      [
        input.org_id, input.fund_type_id, input.bank_account_id,
        input.initiated_by, input.amount_kobo, input.purpose, input.expires_at,
      ],
    );
    return row!;
  },

  async findById(id: string, org_id: string): Promise<PayoutRequest & {
    account_number: string | null;
    bank_name:      string | null;
    recipient_name: string | null;
  } | null> {
    return queryOne(
      `SELECT pr.*,
              oba.account_number,
              oba.bank_name,
              oba.account_name AS recipient_name
       FROM payout_requests pr
       LEFT JOIN org_bank_accounts oba ON oba.id = pr.bank_account_id
       WHERE pr.id = $1 AND pr.org_id = $2`,
      [id, org_id],
    );
  },

  /**
   * findByIdAnyOrg — unscoped lookup for token-authenticated flows.
   *
   * The approval flow authenticates via the signatory's token, not a JWT,
   * so there is no org context to scope by — the token itself already
   * binds to exactly one payout_request row.
   */
  async findByIdAnyOrg(id: string): Promise<PayoutRequest | null> {
    return queryOne<PayoutRequest>(
      `SELECT * FROM payout_requests WHERE id = $1`,
      [id],
    );
  },

  async findByTransferRef(nomba_transfer_ref: string): Promise<PayoutRequest | null> {
    return queryOne<PayoutRequest>(
      `SELECT * FROM payout_requests WHERE nomba_transfer_ref = $1`,
      [nomba_transfer_ref],
    );
  },

  async list(org_id: string, filters: {
    status?: PayoutStatus;
    limit:   number;
    offset:  number;
  }): Promise<PayoutRequest[]> {
    const conditions = ['org_id = $1'];
    const params: unknown[] = [org_id];

    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    params.push(filters.limit, filters.offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    return queryMany<PayoutRequest>(
      `SELECT * FROM payout_requests
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
  },

  async updateStatus(id: string, status: PayoutStatus, extra?: {
    nomba_transfer_ref?: string;
    nomba_transfer_id?:  string;
    transfer_error?:     string;
    declined_by?:        string;
    executed_at?:        Date;
    approvals_received?: number;
  }): Promise<PayoutRequest | null> {
    const sets: string[] = ['status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, status];

    if (extra?.nomba_transfer_ref !== undefined) {
      params.push(extra.nomba_transfer_ref);
      sets.push(`nomba_transfer_ref = $${params.length}`);
    }
    if (extra?.nomba_transfer_id !== undefined) {
      params.push(extra.nomba_transfer_id);
      sets.push(`nomba_transfer_id = $${params.length}`);
    }
    if (extra?.transfer_error !== undefined) {
      params.push(extra.transfer_error);
      sets.push(`transfer_error = $${params.length}`);
    }
    if (extra?.declined_by !== undefined) {
      params.push(extra.declined_by);
      sets.push(`declined_by = $${params.length}`);
    }
    if (extra?.executed_at !== undefined) {
      params.push(extra.executed_at);
      sets.push(`executed_at = $${params.length}`);
    }
    if (extra?.approvals_received !== undefined) {
      params.push(extra.approvals_received);
      sets.push(`approvals_received = $${params.length}`);
    }

    return queryOne<PayoutRequest>(
      `UPDATE payout_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
  },

  // Expired requests — used by expiry.job.ts cron
  async findExpired(): Promise<PayoutRequest[]> {
    return queryMany<PayoutRequest>(
      `SELECT * FROM payout_requests
       WHERE status IN ('PENDING','PARTIAL')
         AND expires_at < NOW()`,
    );
  },
};