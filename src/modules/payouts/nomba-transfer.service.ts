import { nombaClient, nombaClientV2 } from '../../config/nomba';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { AppError, Errors } from '../../utils/AppError';
import { assertKobo, fromKobo } from '../../utils/kobo';
import { payoutTransferRef } from '../../utils/generateRefrence';
//import { lookupBankAccount } from './bank-lookup.service';

/**
 * nomba-transfer.service.ts
 *
 * The single point of contact with Nomba's transfer API.
 *
 * Endpoint: POST /v2/transfers/bank  (v2, NOT v1)
 * Sub-account: POST /v2/transfers/bank/{subAccountId}
 *
 * Transfer lifecycle (from Nomba docs):
 *   data.status = SUCCESS         → settled immediately
 *   data.status = PENDING_BILLING → processing, wait for webhook
 *   data.status = NEW             → processing, wait for webhook
 *   HTTP 201                      → received but not yet processed, rely on webhook
 *   data.status = REFUND          → failed and refunded (on requery)
 *
 * Our approach:
 *   - Fire transfer → mark payout as TRANSFERRING regardless of immediate status
 *   - Webhook (transfer.success / transfer.failed) drives final state
 *   - merchantTxRef = payout_{id} — same ref on retry → Nomba deduplicates
 *   - NEVER generate a new ref for a pending transaction
 *
 * Nomba checklist items covered here:
 *   ✓ Idempotency: every write keyed on unique merchantTxRef
 *   ✓ Recipient name verified via /transfers/bank/lookup before transfer
 *   ✓ Amounts in kobo (assertKobo guard before every call)
 *   ✓ Structured logging with merchantTxRef tagged on every call
 */

export interface TransferInput {
  payoutRequestId: string;
  amountKobo:      number;
  bankCode:        string;
  accountNumber:   string;
  accountName:     string; // must be verified via lookup before calling this
  narration:       string;
}

export type NombaTransferStatus =
  | 'SUCCESS'
  | 'PENDING_BILLING'
  | 'NEW'
  | 'REFUND'
  | string;

export interface TransferResult {
  nombaTransferRef:  string;
  nombaTransferId?:  string;
  nombaStatus:       NombaTransferStatus;
  isImmediate:       boolean; // true if SUCCESS came back synchronously
}

export const nombaTransferService = {
  /**
   * initiateTransfer — POST /v2/transfers/bank/{subAccountId}
   *
   * Step 1: Run /v1/transfers/bank/lookup to verify account (in calling service)
   * Step 2: assertKobo — guard against naira-instead-of-kobo bug
   * Step 3: POST /v2/transfers/bank/{subAccountId} with merchantTxRef as idempotency key
   * Step 4: Handle all three immediate response statuses
   * Step 5: Return — webhook handles final state (TRANSFERRED or FAILED)
   *
   * On retry of a FAILED payout: reuse the same payoutRequestId → same merchantTxRef
   * Nomba deduplicates and returns the original result — no double send.
   *
   * NOTE: Do NOT call this directly — use manualPayoutService or approvalPayoutService.
   * Those services run the lookup and balance checks first.
   */
  async initiateTransfer(input: TransferInput): Promise<TransferResult> {
    const {
      payoutRequestId,
      amountKobo,
      bankCode,
      accountNumber,
      accountName,
      narration,
    } = input;

    // ── Guard: amount must be in kobo ─────────────────────────────────
    assertKobo(amountKobo, 'payout amount');

    const merchantTxRef = payoutTransferRef(payoutRequestId);

    logger.info({
      nomba_ref:         merchantTxRef,
      payout_request_id: payoutRequestId,
      amount_kobo:       amountKobo,
      bank_code:         bankCode,
      account:           accountNumber.slice(-4).padStart(accountNumber.length, '*'),
    }, '[NombaTransfer] Initiating — POST /v2/transfers/bank/{subAccountId}');

    try {
      // Use sub-account endpoint so funds come from Owoore sub-account
      // (not the parent account)
      const response = await nombaClientV2.post(
        `/v2/transfers/bank/${env.NOMBA_SUB_ACCOUNT_ID}`,
        {
          // v2 transfer endpoint takes naira, unlike most other Nomba
          // endpoints — confirmed against GET /v1/accounts/{id}/balance,
          // which returns plain naira decimals (e.g. "360.0"), and by a
          // live rejection: sending amountKobo directly (e.g. 10000 for
          // ₦100) was read as ₦10,000 and rejected as INSUFFICIENT_BALANCE
          // against a real ₦360 balance.
          amount:        fromKobo(amountKobo),
          accountNumber,
          accountName,
          bankCode,
          merchantTxRef,
          senderName:   'Owoore',
          narration:    narration.slice(0, 100), // Nomba narration limit
        },
        {
          // accountId header = parent account (Nomba requirement even for sub-account calls)
          headers: { accountId: env.NOMBA_ACCOUNT_ID },
          // Allow 201 without throwing — it means "processing"
          validateStatus: (status) => status < 500,
        },
      );

      const httpStatus = response.status;
      const body       = response.data;

      // ── Handle 201: processing, rely on webhook ───────────────────────
      // From Nomba docs:
      //   "A 201 means the transfer request was received but the final
      //    outcome is not yet available. Mark as pending, wait for webhook."
      if (httpStatus === 201) {
        logger.info({
          nomba_ref:   merchantTxRef,
          nomba_status: body.data?.status ?? 'PENDING_BILLING',
        }, '[NombaTransfer] 201 received — transfer processing, awaiting webhook');

        return {
          nombaTransferRef: merchantTxRef,
          nombaTransferId:  body.data?.id,
          nombaStatus:      body.data?.status ?? 'PENDING_BILLING',
          isImmediate:      false,
        };
      }

      // ── Handle non-success codes ──────────────────────────────────────
      // Unlike v1 endpoints, this v2 endpoint does NOT use code: '00' for
      // success — confirmed live: a genuinely successful/processing accept
      // came back as { code: '200', status: true, description: 'PROCESSING',
      // data: { status: 'PENDING_BILLING', ... } }. The boolean `status`
      // field is the real success indicator here.
      if (body.status !== true) {
        logger.error({
          nomba_ref: merchantTxRef, http_status: httpStatus, full_response: body,
        }, '[NombaTransfer] Transfer rejected — full response logged for diagnosis');

        throw new AppError(
          `Nomba transfer rejected: ${body.description ?? body.message ?? 'Unknown error'}`,
          502,
          true,
          'NOMBA_TRANSFER_REJECTED',
        );
      }

      const nombaStatus: NombaTransferStatus = body.data?.status ?? 'NEW';
      const nombaTransferId: string | undefined = body.data?.id;

      logger.info({
        nomba_ref:    merchantTxRef,
        nomba_id:     nombaTransferId,
        nomba_status: nombaStatus,
      }, '[NombaTransfer] Transfer initiated');

      // All three statuses (SUCCESS, PENDING_BILLING, NEW) are handled the same:
      // Mark payout as TRANSFERRING and let the webhook drive final state.
      // We only log isImmediate=true for SUCCESS so calling code can optimise if needed.
      return {
        nombaTransferRef: merchantTxRef,
        nombaTransferId,
        nombaStatus,
        isImmediate: nombaStatus === 'SUCCESS',
      };

    } catch (err: any) {
      if (err instanceof AppError) throw err;

      const msg = err.response?.data?.message
               ?? err.response?.data?.description
               ?? err.message;

      logger.error({
        nomba_ref: merchantTxRef,
        err:       msg,
        status:    err.response?.status,
      }, '[NombaTransfer] Transfer call failed');

      throw Errors.nombaError(`Transfer failed: ${msg}`);
    }
  },

  /**
   * requeryTransfer — polls for final status when webhook is delayed.
   *
   * Sub-account requery endpoint:
   *   GET /v1/transactions/accounts/{subAccountId}/single?transactionRef={nombaTransferId}
   *
   * From Nomba docs:
   *   "Transactions may not be immediately available to requery (e.g., within 1 second).
   *    Some transactions may take up to 3 minutes due to NIBSS processing delays."
   *
   * data.status = REFUND means failed and refunded — treat as FAILED.
   */
  async requeryTransfer(nombaTransferId: string): Promise<{
    status:        NombaTransferStatus;
    isSettled:     boolean;
    isFailed:      boolean;
  }> {
    logger.info({ nomba_transfer_id: nombaTransferId },
      '[NombaTransfer] Requerying transfer status');

    try {
      const response = await nombaClient.get(
        `/transactions/accounts/${env.NOMBA_SUB_ACCOUNT_ID}/single`,
        {
          params:  { transactionRef: nombaTransferId },
          headers: { accountId: env.NOMBA_ACCOUNT_ID },
        },
      );

      const { code, data } = response.data;

      if (code !== '00') {
        logger.warn({ nomba_transfer_id: nombaTransferId, code },
          '[NombaTransfer] Requery returned non-success — may still be processing');
        return { status: 'PENDING_BILLING', isSettled: false, isFailed: false };
      }

      const status: NombaTransferStatus = data?.status ?? 'NEW';

      return {
        status,
        isSettled: status === 'SUCCESS',
        isFailed:  status === 'REFUND',
      };

    } catch (err: any) {
      logger.error({ nomba_transfer_id: nombaTransferId, err: err.message },
        '[NombaTransfer] Requery failed');
      return { status: 'NEW', isSettled: false, isFailed: false };
    }
  },

  /**
   * handleTransferSuccess — called by webhook.processor on transfer.success event.
   *
   * Updates:
   *   payout_requests.status → TRANSFERRED
   *   payout_requests.executed_at, nomba_transfer_id
   *   fund_ledger: debit total_paid_out, release soft_lock
   */
  async handleTransferSuccess(
    data: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    // Nomba nests transfer details under data.transaction (same pattern as payment events)
    const tx = (data.transaction ?? data) as Record<string, unknown>;

    const merchantTxRef   = (tx.merchantTxRef  ?? tx.merchantTxReference) as string | undefined;
    const nombaTransferId = (tx.transactionId  ?? tx.id)                  as string | undefined;

    if (!merchantTxRef) {
      logger.warn({ requestId, data }, '[NombaTransfer] payout_success missing merchantTxRef — check payload shape');
      return;
    }

    logger.info({ nomba_ref: merchantTxRef, nomba_id: nombaTransferId },
      '[NombaTransfer] Processing transfer.success webhook');

    const { payoutRepository } = await import('./payout.repository');
    const { ledgerService }    = await import('../transactions/ledger.service');
    const { assertTransition } = await import('./payout-state.machine');
    const { currentPeriod }    = await import('../../utils/formatMoney');
    const { withTransaction }  = await import('../../db');

    const payout = await payoutRepository.findByTransferRef(merchantTxRef);
    if (!payout) {
      logger.warn({ nomba_ref: merchantTxRef }, '[NombaTransfer] No payout found — orphan event');
      return;
    }

    // Guard: only transition from TRANSFERRING
    if (payout.status !== 'TRANSFERRING') {
      logger.warn({ payout_id: payout.id, status: payout.status },
        '[NombaTransfer] Payout not in TRANSFERRING — skipping success handler');
      return;
    }

    assertTransition(payout.status, 'TRANSFERRED');

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payout_requests
         SET status = 'TRANSFERRED', nomba_transfer_id = $2,
             executed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [payout.id, nombaTransferId ?? null],
      );

      await ledgerService.debitLedger(client, {
        org_id:       payout.org_id,
        fund_type_id: payout.fund_type_id,
        amountKobo:   payout.amount_kobo,
        period:       currentPeriod(),
      });
    });

    logger.info({
      payout_id:   payout.id,
      nomba_ref:   merchantTxRef,
      amount_kobo: payout.amount_kobo,
    }, '[NombaTransfer] Payout TRANSFERRED — ledger debited');

    const { auditService } = await import('../audit/audit.service');
    await auditService.record({
      org_id:      payout.org_id,
      actor_type:  'SYSTEM',
      action:      'PAYOUT_TRANSFERRED',
      entity_type: 'payout_request',
      entity_id:   payout.id,
      metadata: {
        amount_kobo:        payout.amount_kobo,
        purpose:            payout.purpose,
        nomba_transfer_ref: merchantTxRef,
        nomba_transfer_id:  nombaTransferId,
      },
    });
  },

  /**
   * handleTransferFailed — called by webhook.processor on transfer.failed event.
   *
   * From Nomba docs:
   *   "If a transaction fails, your account will be automatically refunded
   *    and a refund webhook notification will be sent."
   *
   * Updates:
   *   payout_requests.status → FAILED + transfer_error
   *   fund_ledger: release soft_lock (funds available again for retry)
   */
  async handleTransferFailed(
    data: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    const tx = (data.transaction ?? data) as Record<string, unknown>;

    const merchantTxRef = (tx.merchantTxRef ?? tx.merchantTxReference) as string | undefined;
    const reason        = (
      tx.description ?? tx.reason ?? data.description ?? 'Transfer failed and refunded by Nomba'
    ) as string;

    if (!merchantTxRef) {
      logger.warn({ requestId, data }, '[NombaTransfer] payout_failed missing merchantTxRef — check payload shape');
      return;
    }

    logger.warn({ nomba_ref: merchantTxRef, reason },
      '[NombaTransfer] Processing transfer.failed webhook');

    const { payoutRepository } = await import('./payout.repository');
    const { ledgerService }    = await import('../transactions/ledger.service');
    const { assertTransition } = await import('./payout-state.machine');

    const payout = await payoutRepository.findByTransferRef(merchantTxRef);
    if (!payout) {
      logger.warn({ nomba_ref: merchantTxRef }, '[NombaTransfer] No payout found — orphan event');
      return;
    }

    if (payout.status !== 'TRANSFERRING') {
      logger.warn({ payout_id: payout.id, status: payout.status },
        '[NombaTransfer] Payout not in TRANSFERRING — skipping failed handler');
      return;
    }

    assertTransition(payout.status, 'FAILED');

    await payoutRepository.updateStatus(payout.id, 'FAILED', {
      transfer_error: reason,
    });

    // Release the soft lock — funds back in available balance
    // Admin can now retry (using the same payout request → same merchantTxRef)
    await ledgerService.releaseLock({
      org_id:       payout.org_id,
      fund_type_id: payout.fund_type_id,
      amountKobo:   payout.amount_kobo,
    });

    logger.warn({
      payout_id:   payout.id,
      nomba_ref:   merchantTxRef,
      amount_kobo: payout.amount_kobo,
      reason,
    }, '[NombaTransfer] Payout FAILED — soft lock released, funds available for retry');

    const { auditService } = await import('../audit/audit.service');
    await auditService.record({
      org_id:      payout.org_id,
      actor_type:  'SYSTEM',
      action:      'PAYOUT_TRANSFER_FAILED',
      entity_type: 'payout_request',
      entity_id:   payout.id,
      metadata: {
        amount_kobo:        payout.amount_kobo,
        purpose:            payout.purpose,
        nomba_transfer_ref: merchantTxRef,
        reason,
      },
    });

    // NOTE: On retry, the admin calls POST /payouts again.
    // payout.service.ts reuses the same payout_request_id → same merchantTxRef
    // Nomba docs: "Retry safely — only retry using the same merchantTxRef"
  },
};