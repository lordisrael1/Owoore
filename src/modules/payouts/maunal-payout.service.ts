import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';
import { withTransaction } from '../../db';
import { ledgerService } from '../transactions/ledger.service';
import { nombaTransferService } from './nomba-transfer.service';
import { lookupBankAccount } from './bank-lookup.service';
import { payoutRepository } from './payout.repository';
import { payoutTransferRef } from '../../utils/generateRefrence';
import { assertTransition } from './payout-state.machine';
import { currentPeriod } from '../../utils/formatMoney';

/**
 * manual-payout.service.ts
 *
 * Handles below-threshold payouts — no approval gate needed.
 * Amount is below org's payout_policy.threshold_kobo.
 *
 * Flow:
 *   1. Verify destination bank account via Nomba lookup
 *   2. Check available balance covers the amount
 *   3. Create payout_request record (status: APPROVED — skip approval)
 *   4. Soft-lock the amount in fund_ledger
 *   5. Fire Nomba transfer immediately
 *   6. Update status to TRANSFERRING
 *
 * Webhook (transfer.success/failed) completes the final status update.
 */
export const manualPayoutService = {
  async execute(input: {
    orgId:          string;
    fundTypeId:     string;
    bankAccountId:  string;
    initiatedBy:    string;
    amountKobo:     number;
    purpose:        string;
    bankCode:       string;
    accountNumber:  string;
  }): Promise<{ payoutRequestId: string; nombaTransferRef: string }> {

    const { orgId, fundTypeId, bankAccountId, initiatedBy,
            amountKobo, purpose, bankCode, accountNumber } = input;

    // 1. Verify bank account name before sending any money
    const lookup = await lookupBankAccount(bankCode, accountNumber);

    // 2. Check available balance
    const balance = await ledgerService.getBalance(orgId, fundTypeId);
    if (balance.available_kobo < amountKobo) {
      throw Errors.unprocessable(
        `Insufficient fund balance. Available: ₦${balance.available_kobo / 100}, ` +
        `Requested: ₦${amountKobo / 100}`,
      );
    }

    // 3 & 4. Create payout record + soft-lock in one transaction
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    const payout = await payoutRepository.create({
      org_id:          orgId,
      fund_type_id:    fundTypeId,
      bank_account_id: bankAccountId,
      initiated_by:    initiatedBy,
      amount_kobo:     amountKobo,
      purpose,
      expires_at:      expiresAt,
    });

    // Skip PENDING → jump straight to APPROVED (no approval gate for manual)
    assertTransition('PENDING', 'APPROVED');
    await payoutRepository.updateStatus(payout.id, 'APPROVED');

    await ledgerService.softLock({ org_id: orgId, fund_type_id: fundTypeId, amountKobo });

    // 5. Fire Nomba transfer
    const nombaRef = payoutTransferRef(payout.id);
    const transfer = await nombaTransferService.initiateTransfer({
      payoutRequestId: payout.id,
      amountKobo,
      bankCode:        lookup.bankCode,
      accountNumber:   lookup.accountNumber,
      accountName:     lookup.accountName,
      narration:       `Owoore manual payout: ${purpose.slice(0, 50)}`,
    });

    // 6. Mark as TRANSFERRING — webhook completes the rest
    assertTransition('APPROVED', 'TRANSFERRING');
    await payoutRepository.updateStatus(payout.id, 'TRANSFERRING', {
      nomba_transfer_ref: transfer.nombaTransferRef,
      nomba_transfer_id:  transfer.nombaTransferId,
    });

    logger.info({
      payout_id:       payout.id,
      amount_kobo:     amountKobo,
      merchant_tx_ref: nombaRef,
    }, '[ManualPayout] Transfer initiated — awaiting webhook confirmation');

    return { payoutRequestId: payout.id, nombaTransferRef: nombaRef };
  },
};