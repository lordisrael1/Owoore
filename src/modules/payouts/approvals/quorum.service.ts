import { queryOne, queryMany } from '../../../db';
import { logger } from '../../../utils/logger';

/**
 * quorum.service.ts
 *
 * M-of-N approval logic for payout requests.
 *
 * Rules:
 *   - Initiator is EXCLUDED from approvers (cannot self-approve)
 *   - Any single DECLINE = instant kill (request → DECLINED immediately)
 *   - APPROVED count >= min_approvers = quorum reached → fire transfer
 *   - Quorum checked after every approval action
 */

export interface QuorumCheckResult {
  quorumReached: boolean;
  declined:      boolean;
  declinedBy?:   string;  // signatory_id of decliner
  approvalsIn:   number;
  approvalsNeeded: number;
}

export const quorumService = {
  /**
   * check — evaluates current approval state for a payout request.
   *
   * Called after every approval or decline action.
   * Returns a result the caller uses to decide next state transition.
   */
  async check(payoutRequestId: string, minApprovers: number): Promise<QuorumCheckResult> {
    const rows = await queryMany<{
      action:       string | null;
      signatory_id: string;
    }>(
      `SELECT action, signatory_id
       FROM payout_approvals
       WHERE payout_request_id = $1
         AND token_used_at IS NOT NULL`,  // only count acted-upon tokens
      [payoutRequestId],
    );

    const declined  = rows.find(r => r.action === 'DECLINED');
    const approved  = rows.filter(r => r.action === 'APPROVED');

    if (declined) {
      return {
        quorumReached:   false,
        declined:        true,
        declinedBy:      declined.signatory_id,
        approvalsIn:     approved.length,
        approvalsNeeded: minApprovers,
      };
    }

    const quorumReached = approved.length >= minApprovers;

    logger.info({
      payout_request_id: payoutRequestId,
      approvals_in:      approved.length,
      min_approvers:     minApprovers,
      quorum_reached:    quorumReached,
    }, '[QuorumService] Quorum check');

    return {
      quorumReached,
      declined:        false,
      approvalsIn:     approved.length,
      approvalsNeeded: minApprovers,
    };
  },

  /**
   * getEligibleSignatories — returns signatories who can approve,
   * excluding the initiator (can_approve = true AND id != initiated_by).
   *
   * Called when building the approval email list.
   */
  async getEligibleSignatories(orgId: string, initiatorId: string): Promise<Array<{
    id:    string;
    name:  string;
    email: string;
    phone: string | null;
    role:  string;
  }>> {
    // Exclude the initiator BY EMAIL, matching how isInitiator() blocks
    // them at approval time. The old `s.id != $2` compared a signatories
    // UUID against an admin_users UUID — different tables, never matches —
    // so an initiator-signatory was counted toward quorum feasibility and
    // emailed a link they could never act on: with exactly minApprovers
    // eligible people, quorum became unreachable and the payout silently
    // expired. NOT EXISTS is null-safe if the admin row is missing.
    return queryMany(
      `SELECT s.id, s.name, s.email, s.phone, s.role
       FROM signatories s
       WHERE s.org_id      = $1
         AND s.can_approve = TRUE
         AND s.is_active   = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM admin_users a
           WHERE a.id = $2 AND LOWER(a.email) = LOWER(s.email)
         )`,
      [orgId, initiatorId],
    );
  },

  /**
   * isInitiator — checks if a signatory is the one who initiated the payout.
   * Used to enforce the "initiator cannot approve" rule on the approval page.
   */
  async isInitiator(payoutRequestId: string, signatoryId: string): Promise<boolean> {
    // Signatories and admin_users are separate tables — match by email
    const row = await queryOne<{ initiated_by: string }>(
      `SELECT pr.initiated_by
       FROM payout_requests pr
       WHERE pr.id = $1`,
      [payoutRequestId],
    );

    if (!row) return false;

    // Check if the signatory's email matches the admin who initiated
    const match = await queryOne<{ id: string }>(
      `SELECT s.id FROM signatories s
       JOIN admin_users a ON LOWER(a.email) = LOWER(s.email)
       WHERE s.id = $1 AND a.id = $2`,
      [signatoryId, row.initiated_by],
    );

    return match !== null;
  },
};