import { queryOne } from '../../db';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';
import { env } from '../../config/env';
import { toKobo } from '../../utils/kobo';
import { payoutRepository } from './payout.repository';
import { manualPayoutService } from './maunal-payout.service';
import { ledgerService } from '../transactions/ledger.service';
import { assertTransition, canCancel } from './payout-state.machine';
import { findOrCreateOrgBankAccount } from './bank-account.service';

/**
 * payout.service.ts
 *
 * Orchestrator — receives a payout request and routes it to the
 * correct handler based on the org's payout policy threshold.
 *
 * Three paths:
 *   amount < threshold  → manualPayoutService    (direct transfer, no approval)
 *   amount >= threshold → multi-approver flow    (approval emails, M-of-N gate)
 *   sweep config        → sweepService           (scheduled, system-initiated)
 */

export interface InitPayoutParams {
  orgId:          string;
  fundTypeId:     string;
  bankCode:       string;
  accountNumber:  string;
  initiatedBy:    string;  // admin_user.id
  amountNaira:    number;  // frontend sends naira — we convert to kobo here
  purpose:        string;
}

export const payoutService = {
  /**
   * initiate — entry point for all payout requests from the API.
   *
   * 1. Validate fund and bank account belong to org
   * 2. Convert amount to kobo
   * 3. Check available balance
   * 4. Check threshold → route to manual or multi-approver
   */
  async initiate(params: InitPayoutParams) {
    const { orgId, fundTypeId, bankCode, accountNumber,
            initiatedBy, amountNaira, purpose } = params;

    const amountKobo = toKobo(amountNaira);

    // Verify fund belongs to this org
    const fund = await queryOne<{
      id: string; name: string; is_active: boolean;
    }>(
      `SELECT id, name, is_active FROM fund_types WHERE id = $1 AND org_id = $2`,
      [fundTypeId, orgId],
    );
    if (!fund)        throw Errors.notFound('Fund type');
    if (!fund.is_active) throw Errors.badRequest('Fund type is not active');

    // Verify the recipient via Nomba and reuse/save it as an org bank account
    const bankAccount = await findOrCreateOrgBankAccount({
      orgId, bankCode, accountNumber,
    });

    // Check available balance — reserve headroom for the Nomba transfer fee,
    // which is charged ON TOP of the amount (wallet debits amount + fee)
    const feeBuffer = env.NOMBA_TRANSFER_FEE_KOBO;
    const balance = await ledgerService.getBalance(orgId, fundTypeId);
    if (balance.available_kobo < amountKobo + feeBuffer) {
      throw Errors.unprocessable(
        `Insufficient balance. Available: ₦${(balance.available_kobo / 100).toLocaleString()}, ` +
        `Requested: ₦${amountNaira.toLocaleString()} ` +
        `(plus ₦${(feeBuffer / 100).toLocaleString()} Nomba transfer fee)`,
      );
    }

    // Fetch payout policy for this org
    const policy = await queryOne<{
      min_approvers: number;
      threshold_kobo: number;
      token_expiry_hours: number;
      auto_decline_hours: number;
    }>(
      `SELECT min_approvers, threshold_kobo, token_expiry_hours, auto_decline_hours
       FROM payout_policies WHERE org_id = $1`,
      [orgId],
    );

    // Default policy if not configured yet
    const threshold    = policy?.threshold_kobo    ?? 10_000_000; // ₦100k
    const minApprovers = policy?.min_approvers     ?? 2;
    const autoDeclineH = policy?.auto_decline_hours ?? 72;

    logger.info({
      org_id:      orgId,
      amount_kobo: amountKobo,
      threshold,
      path:        amountKobo < threshold ? 'MANUAL' : 'MULTI_APPROVER',
    }, '[PayoutService] Routing payout request');

    // ── Route: below threshold → manual direct transfer ──────────────────
    if (amountKobo < threshold) {
      return manualPayoutService.execute({
        orgId, fundTypeId, bankAccountId: bankAccount.id, initiatedBy,
        amountKobo, purpose,
        bankCode:      bankAccount.bank_code,
        accountNumber: bankAccount.account_number,
      });
    }

    // ── Route: above threshold → multi-approver flow ─────────────────────
    const { approvalPayoutService } = await import('./approvals/approval.service');
    return approvalPayoutService.initiate({
      orgId, fundTypeId, bankAccountId: bankAccount.id, initiatedBy,
      amountKobo, purpose,
      minApprovers,
      autoDeclineHours: autoDeclineH,
      tokenExpiryHours: policy?.token_expiry_hours ?? 48,
    });
  },

  /**
   * cancel — initiator can cancel a PENDING request (before any approvals).
   */
  async cancel(payoutId: string, orgId: string, requestedBy: string) {
    const payout = await payoutRepository.findById(payoutId, orgId);
    if (!payout) throw Errors.notFound('Payout request');

    if (payout.initiated_by !== requestedBy) {
      throw Errors.forbidden('Only the initiator can cancel a payout request');
    }

    if (!canCancel(payout.status)) {
      throw Errors.conflict(
        `Cannot cancel a payout in status: ${payout.status}. ` +
        'Only PENDING requests (with no approvals) can be cancelled.',
      );
    }

    assertTransition(payout.status, 'CANCELLED');
    // CAS: if a signatory approved between our read and this write, the
    // cancel must lose — never stomp an in-flight approval/transfer.
    const cancelled = await payoutRepository.transitionStatus(
      payoutId, ['PENDING'], 'CANCELLED',
    );
    if (!cancelled) {
      throw Errors.conflict('This payout was just actioned by a signatory and can no longer be cancelled.');
    }

    // Release the soft lock against the exact period row it was applied to
    await ledgerService.releaseLock({
      org_id:       orgId,
      fund_type_id: payout.fund_type_id,
      amountKobo:   payout.amount_kobo,
      lockedPeriod: payout.locked_period_month,
    });

    logger.info({ payout_id: payoutId }, '[PayoutService] Payout cancelled — funds unlocked');
    return { success: true };
  },
};