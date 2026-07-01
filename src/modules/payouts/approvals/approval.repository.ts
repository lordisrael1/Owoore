import { queryOne, queryMany } from '../../../db';

export interface ApprovalRecord {
  id:                string;
  payout_request_id: string;
  signatory_id:      string;
  token:             string;
  token_hash:        string;
  token_expires_at:  Date;
  token_used_at:     Date | null;
  action:            'APPROVED' | 'DECLINED' | null;
  acted_at:          Date | null;
  ip_address:        string | null;
  email_sent_at:     Date | null;
  email_resent_count: number;
  created_at:        Date;
}

export const approvalRepository = {
  async findByToken(rawToken: string): Promise<ApprovalRecord | null> {
    return queryOne<ApprovalRecord>(
      `SELECT * FROM payout_approvals WHERE token = $1`,
      [rawToken],
    );
  },

  async findByPayoutAndSignatory(
    payoutRequestId: string,
    signatoryId: string,
  ): Promise<ApprovalRecord | null> {
    return queryOne<ApprovalRecord>(
      `SELECT * FROM payout_approvals
       WHERE payout_request_id = $1 AND signatory_id = $2`,
      [payoutRequestId, signatoryId],
    );
  },

  async findAllForPayout(payoutRequestId: string): Promise<ApprovalRecord[]> {
    return queryMany<ApprovalRecord>(
      `SELECT pa.*, s.name AS signatory_name, s.email AS signatory_email, s.role
       FROM payout_approvals pa
       JOIN signatories s ON s.id = pa.signatory_id
       WHERE pa.payout_request_id = $1
       ORDER BY pa.created_at ASC`,
      [payoutRequestId],
    );
  },

  async recordAction(
    approvalRecordId: string,
    action: 'APPROVED' | 'DECLINED',
    ipAddress?: string,
  ): Promise<void> {
    await queryOne(
      `UPDATE payout_approvals
       SET action        = $2,
           acted_at      = NOW(),
           token_used_at = NOW(),
           ip_address    = $3
       WHERE id = $1`,
      [approvalRecordId, action, ipAddress ?? null],
    );
  },
};