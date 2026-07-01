import { withTransaction, queryOne } from '../../../db';
import { logger } from '../../../utils/logger';
import { Errors } from '../../../utils/AppError';
import { tokenService } from './token.service';
import { quorumService } from './quorum.service';
import { approvalRepository } from './approval.repository';
import { payoutRepository } from '../payout.repository';
import { ledgerService } from '../../transactions/ledger.service';
import { nombaTransferService } from '../nomba-transfer.service';
import { lookupBankAccount } from '../bank-lookup.service';
import { assertTransition } from '../payout-state.machine';
import { verifyPhoneLast4 } from '../../../utils/crypto';
import { formatNaira } from '../../../utils/formatMoney';
import { env } from '../../../config/env';
import { resend, FROM_ADDRESS, EMAIL_SUBJECTS } from '../../../config/resend';

/**
 * approval.service.ts
 *
 * Orchestrates the full M-of-N email governance flow:
 *   initiate     → create payout_request, generate tokens, send approval emails
 *   processAction → verify token, record action, check quorum, trigger transfer
 *   getDetails   → return payout details for the approval page (no auth — token only)
 */

export const approvalPayoutService = {
  /**
   * initiate — creates a multi-approver payout request and sends approval emails.
   * Called by payout.service.ts when amount >= threshold.
   */
  async initiate(params: {
    orgId:            string;
    fundTypeId:       string;
    bankAccountId:    string;
    initiatedBy:      string;
    amountKobo:       number;
    purpose:          string;
    minApprovers:     number;
    autoDeclineHours: number;
    tokenExpiryHours: number;
  }): Promise<{ payoutRequestId: string; approverCount: number }> {

    const { orgId, fundTypeId, bankAccountId, initiatedBy,
            amountKobo, purpose, minApprovers,
            autoDeclineHours, tokenExpiryHours } = params;

    const expiresAt = new Date(Date.now() + autoDeclineHours * 60 * 60 * 1000);

    // Create payout request
    const payout = await payoutRepository.create({
      org_id: orgId, fund_type_id: fundTypeId,
      bank_account_id: bankAccountId, initiated_by: initiatedBy,
      amount_kobo: amountKobo, purpose, expires_at: expiresAt,
    });

    // Soft-lock the amount immediately
    await ledgerService.softLock({ org_id: orgId, fund_type_id: fundTypeId, amountKobo });

    // Get eligible signatories (excludes initiator)
    const signatories = await quorumService.getEligibleSignatories(orgId, initiatedBy);

    if (signatories.length < minApprovers) {
      throw Errors.unprocessable(
        `Not enough eligible signatories (${signatories.length}) to meet ` +
        `the minimum approvers requirement (${minApprovers}). ` +
        'Add more signatories in Settings → Signatories.',
      );
    }

    // Fetch bank + org details for email
    const bankAccount = await queryOne<{
      bank_name: string; account_number: string; account_name: string;
    }>(
      `SELECT bank_name, account_number, account_name FROM org_bank_accounts WHERE id = $1`,
      [bankAccountId],
    );

    const org = await queryOne<{ name: string }>(
      `SELECT name FROM organisations WHERE id = $1`, [orgId],
    );

    const initiator = await queryOne<{ name: string; email: string }>(
      `SELECT name, email FROM admin_users WHERE id = $1`, [initiatedBy],
    );

    // Generate tokens and send approval emails to all eligible signatories
    let emailsSent = 0;
    for (const signatory of signatories) {
      const { rawToken } = await tokenService.generate({
        payoutRequestId:  payout.id,
        signatoryId:      signatory.id,
        expiryHours:      tokenExpiryHours,
        email:            signatory.email,
      });

      const approveUrl = `${env.APPROVAL_LINK_BASE_URL}/${rawToken}`;
      const declineUrl = `${env.APPROVAL_LINK_BASE_URL}/${rawToken}/decline`;

      await this.sendApprovalEmail({
        to:              signatory.email,
        signatoryName:   signatory.name,
        initiatorName:   initiator?.name ?? 'Treasurer',
        orgName:         org?.name ?? 'Your Church',
        amountKobo,
        purpose,
        bankName:        bankAccount?.bank_name ?? '',
        accountNumber:   bankAccount?.account_number ?? '',
        accountName:     bankAccount?.account_name  ?? '',
        approveUrl,
        declineUrl,
        expiryHours:     tokenExpiryHours,
        minApprovers,
        totalSignatories: signatories.length,
      });

      emailsSent++;
    }

    logger.info({
      payout_id:    payout.id,
      amount_kobo:  amountKobo,
      emails_sent:  emailsSent,
      min_approvers: minApprovers,
    }, '[ApprovalService] Multi-approver payout initiated — emails sent');

    return { payoutRequestId: payout.id, approverCount: emailsSent };
  },

  /**
   * getDetails — returns payout details for the approval page.
   * No JWT needed — token is the credential. Called on GET /approve/:token.
   */
  async getDetails(rawToken: string): Promise<{
    payoutId:    string;
    amountKobo:  number;
    purpose:     string;
    fundName:    string;
    bankName:    string;
    accountNumber: string;
    accountName:   string;
    initiatorName: string;
    orgName:       string;
    expiresAt:     Date;
    alreadyActed:  boolean;
  }> {
    const tokenRecord = await tokenService.verify(rawToken);

    const payout = await queryOne<{
      id: string; amount_kobo: number; purpose: string;
      expires_at: Date; initiated_by: string; org_id: string;
      fund_type_id: string; bank_account_id: string;
    }>(
      `SELECT id, amount_kobo, purpose, expires_at,
              initiated_by, org_id, fund_type_id, bank_account_id
       FROM payout_requests WHERE id = $1`,
      [tokenRecord.payout_request_id],
    );

    if (!payout) throw Errors.notFound('Payout request');

    const [fund, bank, initiator, org] = await Promise.all([
      queryOne<{ name: string }>(`SELECT name FROM fund_types WHERE id = $1`, [payout.fund_type_id]),
      queryOne<{ bank_name: string; account_number: string; account_name: string }>(
        `SELECT bank_name, account_number, account_name FROM org_bank_accounts WHERE id = $1`,
        [payout.bank_account_id],
      ),
      queryOne<{ name: string }>(`SELECT name FROM admin_users WHERE id = $1`, [payout.initiated_by]),
      queryOne<{ name: string }>(`SELECT name FROM organisations WHERE id = $1`, [payout.org_id]),
    ]);

    return {
      payoutId:      payout.id,
      amountKobo:    payout.amount_kobo,
      purpose:       payout.purpose,
      fundName:      fund?.name        ?? '',
      bankName:      bank?.bank_name   ?? '',
      accountNumber: bank?.account_number ?? '',
      accountName:   bank?.account_name   ?? '',
      initiatorName: initiator?.name   ?? '',
      orgName:       org?.name         ?? '',
      expiresAt:     payout.expires_at,
      alreadyActed:  tokenRecord.action !== null,
    };
  },

  /**
   * processAction — records approve or decline and checks quorum.
   *
   * Called on POST /approve/:token (approve) or POST /decline/:token.
   * No JWT — the token + phone-last-4 is the auth.
   */
  async processAction(params: {
    rawToken:    string;
    action:      'APPROVED' | 'DECLINED';
    phoneLast4:  string;    // identity confirm
    ipAddress?:  string;
  }): Promise<{ status: string; message: string }> {

    const { rawToken, action, phoneLast4, ipAddress } = params;

    // 1. Verify token
    const tokenRecord = await tokenService.verify(rawToken);

    if (tokenRecord.action !== null) {
      throw Errors.conflict('You have already responded to this approval request.');
    }

    // 2. Fetch signatory and verify phone last-4
    const signatory = await queryOne<{
      id: string; name: string; phone: string | null;
    }>(
      `SELECT id, name, phone FROM signatories WHERE id = $1`,
      [tokenRecord.signatory_id],
    );

    if (!signatory) throw Errors.notFound('Signatory');

    if (signatory.phone && !verifyPhoneLast4(phoneLast4, signatory.phone)) {
      throw Errors.unauthorized(
        'Phone number verification failed. Please enter the last 4 digits of your registered phone.',
      );
    }

    // 3. Check initiator exclusion
    const isInitiator = await quorumService.isInitiator(
      tokenRecord.payout_request_id, tokenRecord.signatory_id,
    );
    if (isInitiator) {
      throw Errors.forbidden('The payout initiator cannot approve their own request.');
    }

    // 4. Fetch payout and validate status
    const payout = await payoutRepository.findById(tokenRecord.payout_request_id, '');
    if (!payout) throw Errors.notFound('Payout request');

    if (!['PENDING', 'PARTIAL'].includes(payout.status)) {
      throw Errors.conflict(`This payout is no longer awaiting approval (status: ${payout.status})`);
    }

    // 5. Record the action
    await approvalRepository.recordAction(tokenRecord.id, action, ipAddress);
    await tokenService.markUsed(tokenRecord.id, ipAddress);

    // 6. Handle decline — instant kill
    if (action === 'DECLINED') {
      assertTransition(payout.status, 'DECLINED');
      await payoutRepository.updateStatus(payout.id, 'DECLINED', {
        declined_by: tokenRecord.signatory_id,
      });

      await ledgerService.releaseLock({
        org_id:       payout.org_id,
        fund_type_id: payout.fund_type_id,
        amountKobo:   payout.amount_kobo,
      });

      logger.warn({
        payout_id:    payout.id,
        signatory_id: tokenRecord.signatory_id,
        signatory:    signatory.name,
      }, '[ApprovalService] Payout DECLINED — funds unlocked');

      return { status: 'DECLINED', message: 'You have declined this payout request.' };
    }

    // 7. Handle approve — check quorum
    const policy = await queryOne<{ min_approvers: number }>(
      `SELECT min_approvers FROM payout_policies WHERE org_id = $1`,
      [payout.org_id],
    );
    const minApprovers = policy?.min_approvers ?? 2;

    const quorum = await quorumService.check(payout.id, minApprovers);

    if (!quorum.quorumReached) {
      // Move to PARTIAL — still waiting for more approvals
      const newStatus = payout.status === 'PENDING' ? 'PARTIAL' : 'PARTIAL';
      assertTransition(payout.status, newStatus);
      await payoutRepository.updateStatus(payout.id, newStatus, {
        approvals_received: quorum.approvalsIn,
      });

      logger.info({
        payout_id:      payout.id,
        approvals_in:   quorum.approvalsIn,
        approvals_needed: quorum.approvalsNeeded,
      }, '[ApprovalService] Approval recorded — quorum not yet reached');

      return {
        status:  'PARTIAL',
        message: `Approval recorded. ${quorum.approvalsNeeded - quorum.approvalsIn} more approval(s) needed.`,
      };
    }

    // 8. Quorum reached — fire the transfer
    logger.info({ payout_id: payout.id }, '[ApprovalService] Quorum reached — firing transfer');

    assertTransition(payout.status, 'APPROVED');
    await payoutRepository.updateStatus(payout.id, 'APPROVED');

    // Fetch bank account details for transfer
    const bankAccount = await queryOne<{
      bank_code: string; account_number: string; account_name: string;
    }>(
      `SELECT bank_code, account_number, account_name FROM org_bank_accounts WHERE id = $1`,
      [payout.bank_account_id],
    );

    if (!bankAccount) throw Errors.notFound('Bank account');

    assertTransition('APPROVED', 'TRANSFERRING');
    await payoutRepository.updateStatus(payout.id, 'TRANSFERRING');

    // Fire Nomba transfer
    const transfer = await nombaTransferService.initiateTransfer({
      payoutRequestId: payout.id,
      amountKobo:      payout.amount_kobo,
      bankCode:        bankAccount.bank_code,
      accountNumber:   bankAccount.account_number,
      accountName:     bankAccount.account_name,
      narration:       `Owoore payout: ${payout.purpose.slice(0, 50)}`,
    });

    await payoutRepository.updateStatus(payout.id, 'TRANSFERRING', {
      nomba_transfer_ref: transfer.nombaTransferRef,
      nomba_transfer_id:  transfer.nombaTransferId,
    });

    logger.info({
      payout_id:       payout.id,
      nomba_tx_ref:    transfer.nombaTransferRef,
    }, '[ApprovalService] Transfer initiated after quorum');

    return {
      status:  'TRANSFER_INITIATED',
      message: 'Quorum reached. Transfer has been initiated and is being processed.',
    };
  },

  // ── Email helpers ──────────────────────────────────────────────────────

  async sendApprovalEmail(params: {
    to:              string;
    signatoryName:   string;
    initiatorName:   string;
    orgName:         string;
    amountKobo:      number;
    purpose:         string;
    bankName:        string;
    accountNumber:   string;
    accountName:     string;
    approveUrl:      string;
    declineUrl:      string;
    expiryHours:     number;
    minApprovers:    number;
    totalSignatories: number;
  }): Promise<void> {
    const {
      to, signatoryName, initiatorName, orgName, amountKobo, purpose,
      bankName, accountNumber, accountName, approveUrl, declineUrl, expiryHours,
      minApprovers, totalSignatories,
    } = params;

    const amount    = formatNaira(amountKobo);
    const maskedAcc = `*${accountNumber.slice(-4)}`;

    const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr>
        <td style="background:#7c3aed;padding:24px 32px;">
          <p style="margin:0;color:#fff;font-size:20px;font-weight:600;">Owoore</p>
          <p style="margin:4px 0 0;color:#ddd6fe;font-size:13px;">Payout Approval Required</p>
        </td>
      </tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 16px;color:#111827;font-size:15px;">Hi ${signatoryName},</p>
        <p style="margin:0 0 24px;color:#374151;">
          <strong>${initiatorName}</strong> has requested a fund transfer from
          <strong>${orgName}</strong> and requires your approval.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background:#f5f3ff;border-radius:8px;margin-bottom:16px;">
          <tr><td style="padding:20px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="color:#6b7280;font-size:12px;padding:4px 0;">Amount</td>
                <td style="color:#1f2937;font-size:16px;font-weight:700;text-align:right;">${amount}</td>
              </tr>
              <tr>
                <td style="color:#6b7280;font-size:12px;padding:4px 0;">Destination</td>
                <td style="color:#1f2937;font-size:13px;text-align:right;">${bankName} · ${accountName} · ${maskedAcc}</td>
              </tr>
              <tr>
                <td style="color:#6b7280;font-size:12px;padding:4px 0;">Purpose</td>
                <td style="color:#1f2937;font-size:13px;text-align:right;">${purpose}</td>
              </tr>
              <tr>
                <td style="color:#6b7280;font-size:12px;padding:4px 0;">Approvals needed</td>
                <td style="color:#1f2937;font-size:13px;text-align:right;">${minApprovers} of ${totalSignatories} signatories</td>
              </tr>
              <tr>
                <td style="color:#6b7280;font-size:12px;padding:4px 0;">Link expires</td>
                <td style="color:#1f2937;font-size:13px;text-align:right;">In ${expiryHours} hours</td>
              </tr>
            </table>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="48%" style="padding-right:8px;">
              <a href="${approveUrl}"
                 style="display:block;background:#166534;color:#fff;text-align:center;
                        padding:12px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
                ✓ Approve Transfer
              </a>
            </td>
            <td width="48%" style="padding-left:8px;">
              <a href="${declineUrl}"
                 style="display:block;background:#fef2f2;color:#991b1b;text-align:center;
                        padding:12px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
                ✗ Decline
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0;color:#9ca3af;font-size:11px;border-top:1px solid #f3f4f6;padding-top:16px;">
          This link is unique to you and expires in ${expiryHours} hours. Do not forward it.<br/>
          You will be asked to confirm the last 4 digits of your registered phone number.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    try {
      await resend.emails.send({
        from:    FROM_ADDRESS,
        to,
        subject: EMAIL_SUBJECTS.APPROVAL_REQUEST(amount, ''),
        html,
      });
      logger.info({ to: to.slice(0, 3) + '***' }, '[ApprovalService] Approval email sent');
    } catch (err: any) {
      logger.error({ to: to.slice(0, 3) + '***', err: err.message },
        '[ApprovalService] Failed to send approval email');
      throw err; // Fatal — rethrow so the payout initiation fails cleanly
    }
  },
};