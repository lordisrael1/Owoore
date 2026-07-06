import { logger } from '../../utils/logger';
import { withTransaction, queryOne } from '../../db';
import { currentPeriod } from '../../utils/formatMoney';
import { reconciliationService } from '../transactions/reconciliation.service';
import { ledgerService } from '../transactions/ledger.service';
import { notificationDispatcher } from './notification.dispatcher';
import { auditService } from '../audit/audit.service';

/**
 * inflow-handler.service.ts
 *
 * Handles the virtual_account.funded webhook event — the most critical
 * flow in Owoore. Every member payment triggers this path.
 *
 * Full pipeline (atomic transaction):
 *   1. Lookup account_reference → resolve member + fund + org
 *   2. Check if shared fund VA (Anonymous Giving, Offering, etc.)
 *   3. Run reconciliation (expected vs received)
 *   4. Write transaction record
 *   5. Update fund_ledger (running balance)
 *   6. Send member notification (SMS + email)
 *
 * Everything from step 1-5 runs inside a single DB transaction.
 * If any step fails, the entire transaction rolls back —
 * no partial state, no orphaned records.
 *
 * Notifications (step 6) fire AFTER the transaction commits —
 * we never hold a DB transaction open while calling external APIs.
 */

/**
 * Nomba payment_success payload shape (nested).
 * data.transaction holds the VA details; data.customer holds sender info.
 */
interface NombaPaymentSuccessData {
  transaction: {
    aliasAccountReference: string;   // our accountRef (VA lookup key)
    aliasAccountNumber:    string;   // NUBAN that received the payment
    transactionAmount:     number;   // NAIRA (float) — must × 100 for kobo
    fee?:                  number;   // NAIRA — Nomba inbound charge (wallet gets amount − fee)
    sessionId?:            string;
    transactionId?:        string;
    narration?:            string;
  };
  customer?: {
    accountNumber?: string;
    bankName?:      string;
    senderName?:    string;
  };
}

export const inflowHandlerService = {
  async handle(data: Record<string, unknown>, requestId: string): Promise<void> {
    const payload   = data as unknown as NombaPaymentSuccessData;
    const tx        = payload.transaction;
    const customer  = payload.customer;

    const accountReference = tx?.aliasAccountReference;
    if (!accountReference) {
      logger.warn({ requestId }, '[InflowHandler] No aliasAccountReference in payload — cannot reconcile');
      return;
    }

    // Nomba sends transactionAmount and fee in NAIRA — convert to kobo
    const amountKobo         = Math.round((tx.transactionAmount ?? 0) * 100);
    const feeKobo            = Math.round((tx.fee ?? 0) * 100);
    const narration          = tx.narration;
    const sessionId          = tx.sessionId;
    const transactionReference = tx.transactionId;
    const senderAccountNumber  = customer?.accountNumber;
    const senderBankName       = customer?.bankName;
    const senderName           = customer?.senderName;

    logger.info({
      account_reference: accountReference,
      amount_naira:      tx.transactionAmount,
      amount_kobo:       amountKobo,
      nomba_request_id:  requestId,
    }, '[InflowHandler] Processing inflow');

    // ── Determine if this is a per-member VA or a shared org+fund VA ────
    // Shared funds (Anonymous Giving, Offering, etc.) have no member
    // attribution — accountReference format: s_{30-char hash}
    const isShared = accountReference.startsWith('s_');

    if (isShared) {
      await this.handleSharedFundInflow({
        accountReference, amountKobo, feeKobo, narration, sessionId,
        transactionReference, senderAccountNumber, senderBankName, senderName,
      }, requestId);
      return;
    }

    // ── Member VA flow ───────────────────────────────────────────────────

    // 1. Lookup member + fund + org from account_reference
    const memberAccount = await queryOne<{
      id:               string;
      member_id:        string;
      fund_type_id:     string;
      org_id:           string;
      expected_amt_kobo: number | null;
      member_email:     string;
      member_name:      string;
      fund_name:        string;
      org_name:         string;
    }>(
      `SELECT
         mfa.id,
         mfa.member_id,
         mfa.fund_type_id,
         mfa.org_id,
         ft.expected_amt_kobo,
         m.email    AS member_email,
         m.display_name AS member_name,
         ft.name    AS fund_name,
         o.name     AS org_name
       FROM member_fund_accounts mfa
       JOIN members    m  ON m.id  = mfa.member_id
       JOIN fund_types ft ON ft.id = mfa.fund_type_id
       JOIN organisations o ON o.id = mfa.org_id
       WHERE mfa.account_reference = $1`,
      [accountReference],
    );

    if (!memberAccount) {
      logger.error({ accountReference, requestId },
        '[InflowHandler] No member_fund_account found for reference — orphan payment');
      // This should never happen — log for investigation but don't throw
      // (throwing would cause Nomba retries for an unresolvable event)
      return;
    }

    const {
      id: memberFundAccountId,
      member_id,
      fund_type_id,
      org_id,
      expected_amt_kobo,
    } = memberAccount;

    // 2. Run reconciliation — compute payment status and variance
    const reconciliation = reconciliationService.reconcile({
      amountKobo,
      expectedAmtKobo: expected_amt_kobo ?? null,
    });

    const period = currentPeriod();

    // 3-5. Atomic: write transaction + update ledger
    const { transactionId } = await withTransaction(async (client) => {
      // Write transaction record
      const txResult = await client.query<{ id: string }>(
        `INSERT INTO transactions (
           member_fund_account_id, member_id, fund_type_id, org_id,
           amount_kobo, fee_kobo, expected_amt_kobo, variance_kobo, payment_status,
           nomba_tx_ref, nomba_session_id,
           sender_account, sender_bank, sender_name,
           narration, period_month, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         RETURNING id`,
        [
          memberFundAccountId,
          member_id,
          fund_type_id,
          org_id,
          amountKobo,
          feeKobo,
          expected_amt_kobo,
          reconciliation.varianceKobo,
          reconciliation.status,
          transactionReference ?? requestId,
          sessionId,
          senderAccountNumber,
          senderBankName,
          senderName,
          narration,
          period,
        ],
      );

      // Unique-giver check: any OTHER payment by this member to this fund
      // this period? (The row above is already inserted, so exclude it.)
      const priorTx = await client.query(
        `SELECT 1 FROM transactions
         WHERE member_fund_account_id = $1 AND period_month = $2 AND id <> $3
         LIMIT 1`,
        [memberFundAccountId, period, txResult.rows[0]?.id],
      );

      // Update fund ledger — gross credit, fee tracked separately
      await ledgerService.creditLedger(client, {
        org_id,
        fund_type_id,
        amountKobo,
        feeKobo,
        period,
        isFirstGiftThisPeriod: priorTx.rowCount === 0,
      });

      return { transactionId: txResult.rows[0]?.id };
    });

    logger.info({
      member_id,
      fund_type_id,
      amount_kobo:       amountKobo,
      payment_status:    reconciliation.status,
      variance_kobo:     reconciliation.varianceKobo,
      nomba_request_id:  requestId,
    }, '[InflowHandler] Transaction written and ledger updated');

    await auditService.record({
      org_id,
      actor_type:  'WEBHOOK',
      action:      'PAYMENT_RECEIVED',
      entity_type: 'transaction',
      entity_id:   transactionId,
      metadata: {
        member_id,
        member_name:      memberAccount.member_name,
        fund_type_id,
        fund_name:        memberAccount.fund_name,
        amount_kobo:      amountKobo,
        fee_kobo:         feeKobo,
        payment_status:   reconciliation.status,
        variance_kobo:    reconciliation.varianceKobo,
        sender_name:      senderName,
        nomba_request_id: requestId,
      },
    });

    // 6. Send notification — fires AFTER commit, never inside withTransaction
    notificationDispatcher.notifyMemberPayment({
      email:         memberAccount.member_email,
      memberName:    memberAccount.member_name,
      amountKobo,
      fundName:      memberAccount.fund_name,
      orgName:       memberAccount.org_name,
      status:        reconciliation.status,
      deficitKobo:   reconciliation.deficitKobo,
      accountNumber: tx.aliasAccountNumber,
    }).catch((err) => {
      logger.warn({ member_id, err: err.message },
        '[InflowHandler] Notification failed — payment still recorded');
    });
  },

  // ── Shared fund inflow (Anonymous Giving, Offering, etc.) ───────────────
  async handleSharedFundInflow(
    fields: {
      accountReference:    string;
      amountKobo:          number;
      feeKobo?:            number;
      narration?:          string;
      sessionId?:          string;
      transactionReference?: string;
      senderAccountNumber?:  string;
      senderBankName?:       string;
      senderName?:           string;
    },
    requestId: string,
  ): Promise<void> {
    const sharedAccount = await queryOne<{ org_id: string; fund_type_id: string; fund_name: string }>(
      `SELECT osfa.org_id, osfa.fund_type_id, ft.name AS fund_name
       FROM org_shared_fund_accounts osfa
       JOIN fund_types ft ON ft.id = osfa.fund_type_id
       WHERE osfa.account_reference = $1`,
      [fields.accountReference],
    );

    if (!sharedAccount) {
      logger.error({ ref: fields.accountReference, requestId },
        '[InflowHandler] No shared fund account found for reference — orphan payment');
      return;
    }

    const { org_id, fund_type_id } = sharedAccount;
    const feeKobo = fields.feeKobo ?? 0;
    const period = currentPeriod();

    const { transactionId } = await withTransaction(async (client) => {
      const txResult = await client.query<{ id: string }>(
        `INSERT INTO anonymous_transactions (
           org_id, fund_type_id, amount_kobo, fee_kobo,
           nomba_tx_ref, nomba_session_id,
           sender_account, sender_bank, sender_name,
           narration, period_month, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         RETURNING id`,
        [
          org_id,
          fund_type_id,
          fields.amountKobo,
          feeKobo,
          fields.transactionReference ?? requestId,
          fields.sessionId,
          fields.senderAccountNumber,
          fields.senderBankName,
          fields.senderName,
          fields.narration,
          period,
        ],
      );

      await ledgerService.creditLedger(client, {
        org_id,
        fund_type_id,
        amountKobo: fields.amountKobo,
        feeKobo,
        period,
        // Anonymous/shared inflows carry no member identity — they can never
        // count toward unique givers
        isFirstGiftThisPeriod: false,
      });

      return { transactionId: txResult.rows[0]?.id };
    });

    logger.info({
      org_id,
      fund_type_id,
      amount_kobo:      fields.amountKobo,
      nomba_request_id: requestId,
    }, '[InflowHandler] Shared fund inflow recorded');

    await auditService.record({
      org_id,
      actor_type:  'WEBHOOK',
      action:      'ANONYMOUS_PAYMENT_RECEIVED',
      entity_type: 'anonymous_transaction',
      entity_id:   transactionId,
      metadata: {
        fund_type_id,
        fund_name:        sharedAccount.fund_name,
        amount_kobo:      fields.amountKobo,
        fee_kobo:         feeKobo,
        sender_name:      fields.senderName,
        nomba_request_id: requestId,
      },
    });
  },
};