import { queryMany } from '../../db';
import { logger } from '../../utils/logger';
import { ledgerService } from '../transactions/ledger.service';
import { nombaTransferService } from './nomba-transfer.service';
import { lookupBankAccount } from './bank-lookup.service';
import { payoutRepository } from './payout.repository';
//import { currentPeriod } from '../../utils/formatMoney';
//import { payoutTransferRef } from '../../utils/generateReference';

/**
 * sweep.service.ts — auto-sweep: check schedule, check min balance, fire transfer.
 *
 * Called by sweep.job.ts cron (nightly).
 * For each sweep_config row that is due today and enabled:
 *   1. Check fund balance >= min_balance_kobo
 *   2. Look up destination bank account
 *   3. Create payout_request (status: APPROVED — no approval for auto-sweep)
 *   4. Fire Nomba transfer
 *   5. Update last_swept_at
 */

interface SweepConfig {
  id:             string;
  org_id:         string;
  fund_type_id:   string;
  bank_account_id:string;
  schedule:       'WEEKLY' | 'MONTHLY' | 'MANUAL';
  sweep_day:      number | null;
  min_balance_kobo: number;
  bank_code:      string;
  account_number: string;
  org_name:       string;
  fund_name:      string;
}

export const sweepService = {
  /**
   * runDueSweeps — main entry called by the cron job.
   * Finds all sweep configs due today and processes each one.
   */
  async runDueSweeps(): Promise<void> {
    const now = new Date();
    const dayOfWeek  = now.getDay();        // 0=Sun … 6=Sat
    const dayOfMonth = now.getDate();       // 1-28

    // Find all enabled sweep configs due today
    const dueSweeps = await queryMany<SweepConfig>(
      `SELECT
         sc.id, sc.org_id, sc.fund_type_id, sc.bank_account_id,
         sc.schedule, sc.sweep_day, sc.min_balance_kobo,
         oba.bank_code, oba.account_number,
         o.name AS org_name, ft.name AS fund_name
       FROM sweep_configs sc
       JOIN org_bank_accounts oba ON oba.id = sc.bank_account_id
       JOIN organisations     o   ON o.id   = sc.org_id
       JOIN fund_types        ft  ON ft.id  = sc.fund_type_id
       WHERE sc.is_enabled = TRUE
         AND sc.schedule  != 'MANUAL'
         AND (
           (sc.schedule = 'WEEKLY'  AND sc.sweep_day = $1)
           OR
           (sc.schedule = 'MONTHLY' AND sc.sweep_day = $2)
         )`,
      [dayOfWeek, dayOfMonth],
    );

    if (dueSweeps.length === 0) {
      logger.info('[Sweep] No sweeps due today');
      return;
    }

    logger.info({ count: dueSweeps.length }, '[Sweep] Processing due sweeps');

    // Process each sweep independently — one failure doesn't block others
    const results = await Promise.allSettled(
      dueSweeps.map((config) => this.processSweep(config)),
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed    = results.filter(r => r.status === 'rejected').length;

    logger.info({ succeeded, failed, total: dueSweeps.length },
      '[Sweep] Sweep run complete');
  },

  async processSweep(config: SweepConfig): Promise<void> {
    const { org_id, fund_type_id, bank_account_id,
            bank_code, account_number, min_balance_kobo,
            org_name, fund_name } = config;

    // 1. Check available balance
    const balance = await ledgerService.getBalance(org_id, fund_type_id);

    if (balance.available_kobo <= 0) {
      logger.info({ org_id, fund_type_id }, '[Sweep] Zero balance — skipping');
      return;
    }

    if (balance.available_kobo < min_balance_kobo) {
      logger.info({
        org_id, fund_type_id,
        available_kobo: balance.available_kobo,
        min_balance_kobo,
      }, '[Sweep] Balance below minimum threshold — skipping');
      return;
    }

    const amountKobo = balance.available_kobo;

    // 2. Verify destination bank account
    const lookup = await lookupBankAccount(bank_code, account_number);

    // 3. Create payout record — APPROVED immediately (auto-sweep bypasses approval)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const payout = await payoutRepository.create({
      org_id, fund_type_id, bank_account_id,
      initiated_by: 'system',  // system-initiated
      amount_kobo:  amountKobo,
      purpose:      `Auto-sweep — ${fund_name} — ${new Date().toLocaleDateString('en-NG')}`,
      expires_at:   expiresAt,
    });

    await payoutRepository.updateStatus(payout.id, 'APPROVED');
    await ledgerService.softLock({ org_id, fund_type_id, amountKobo });

    // 4. Fire Nomba transfer
    const transfer = await nombaTransferService.initiateTransfer({
      payoutRequestId: payout.id,
      amountKobo,
      bankCode:        lookup.bankCode,
      accountNumber:   lookup.accountNumber,
      accountName:     lookup.accountName,
      narration:       `Owoore auto-sweep: ${fund_name.slice(0, 40)}`,
    });

    await payoutRepository.updateStatus(payout.id, 'TRANSFERRING', {
      nomba_transfer_ref: transfer.nombaTransferRef,
      nomba_transfer_id:  transfer.nombaTransferId,
    });

    // 5. Update last_swept_at
    await queryMany(
      `UPDATE sweep_configs SET last_swept_at = NOW() WHERE id = $1`,
      [config.id],
    );

    logger.info({
      payout_id:    payout.id,
      org_name,
      fund_name,
      amount_kobo:  amountKobo,
    }, '[Sweep] Auto-sweep transfer initiated');
  },
};