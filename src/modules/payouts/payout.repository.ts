import { queryOne, queryMany } from '../../db';
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
  locked_period_month: string | null; // fund_ledger row the soft_lock targets
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

  /**
   * createTx — create inside the caller's transaction, atomically with
   * ledgerService.checkAndLock. Persists the locked ledger period so
   * every later release/debit targets the same row.
   */
  async createTx(client: import('pg').PoolClient, input: {
    org_id:              string;
    fund_type_id:        string;
    bank_account_id:     string;
    initiated_by:        string;
    amount_kobo:         number;
    purpose:             string;
    expires_at:          Date;
    locked_period_month: string;
  }): Promise<PayoutRequest> {
    const res = await client.query<PayoutRequest>(
      `INSERT INTO payout_requests
         (org_id, fund_type_id, bank_account_id, initiated_by,
          amount_kobo, purpose, status, expires_at, locked_period_month,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,NOW(),NOW())
       RETURNING *`,
      [
        input.org_id, input.fund_type_id, input.bank_account_id,
        input.initiated_by, input.amount_kobo, input.purpose,
        input.expires_at, input.locked_period_month,
      ],
    );
    return res.rows[0];
  },

  /**
   * transitionStatus — atomic compare-and-set state transition.
   *
   * Only succeeds when the row is STILL in one of fromStatuses at write
   * time — the DB enforces the state machine under concurrency, not a
   * stale in-memory read. Returns the updated row, or null when another
   * actor (a concurrent approver, the expiry job) advanced it first;
   * callers must treat null as "someone else won — do not proceed".
   */
  async transitionStatus(
    id: string,
    fromStatuses: PayoutStatus[],
    to: PayoutStatus,
    extra?: {
      nomba_transfer_ref?: string;
      nomba_transfer_id?:  string;
      transfer_error?:     string;
      declined_by?:        string;
      approvals_received?: number;
    },
  ): Promise<PayoutRequest | null> {
    const sets: string[] = ['status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, to, fromStatuses];

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
    if (extra?.approvals_received !== undefined) {
      params.push(extra.approvals_received);
      sets.push(`approvals_received = $${params.length}`);
    }

    return queryOne<PayoutRequest>(
      `UPDATE payout_requests SET ${sets.join(', ')}
       WHERE id = $1 AND status = ANY($3)
       RETURNING *`,
      params,
    );
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

  /**
   * fundBalances — all-time available balance per active fund.
   *
   * Mirrors ledgerService.getBalance exactly (all-time SUM over fund_ledger,
   * fees + paid_out + soft_lock subtracted, floored at 0) so the number the
   * admin sees on the initiate-payout form is the same number the balance
   * check in payoutService.initiate enforces.
   *
   * Includes anonymous-only funds — money given anonymously is still
   * payable out, it's only hidden from member-facing fund lists.
   */
  async fundBalances(org_id: string): Promise<Array<{
    fund_type_id:      string;
    fund_name:         string;
    kind:              string;
    is_anonymous_only: boolean;
    available_kobo:    string; // BIGINT comes back as string from pg
  }>> {
    return queryMany(
      `SELECT
         ft.id                AS fund_type_id,
         ft.name              AS fund_name,
         ft.kind,
         ft.is_anonymous_only,
         GREATEST(0, COALESCE(SUM(
           fl.total_collected_kobo - fl.total_fees_kobo
           - fl.total_paid_out_kobo - fl.soft_lock_kobo
         ), 0))::BIGINT AS available_kobo
       FROM fund_types ft
       LEFT JOIN fund_ledger fl ON fl.fund_type_id = ft.id
       WHERE ft.org_id = $1 AND ft.is_active = TRUE
       GROUP BY ft.id, ft.name, ft.kind, ft.is_anonymous_only
       ORDER BY ft.sort_order ASC`,
      [org_id],
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