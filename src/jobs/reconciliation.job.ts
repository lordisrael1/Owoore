import { logger } from '../utils/logger';
import { nombaClient } from '../config/nomba';
import { env } from '../config/env';
import { query, queryMany } from '../db';
import { currentPeriod } from '../utils/formatMoney';

/**
 * reconciliation.job.ts — CRITICAL — Nomba build-week checklist item.
 *
 * Nomba checklist: "Nightly reconciliation job comparing /transactions to your ledger"
 *
 * GET /transactions from Nomba, diff vs local ledger, alert on drift.
 *
 * What it checks:
 *   1. Pull transactions from Nomba for the current period
 *   2. Compare each against our local transactions table (by nomba_tx_ref)
 *   3. Alert if any Nomba transaction is missing from our DB (orphan)
 *   4. Alert if amount differs (drift)
 *   5. Log any orphan anonymous transactions we may have missed
 *
 * schedule: '0 2 * * *'  → 2am every night (after sweep completes)
 */
export async function runReconciliationJob(): Promise<void> {
  logger.info('[ReconciliationJob] Starting nightly Nomba ledger diff');

  try {
    const period = currentPeriod(); // YYYY-MM
    const [year, month] = period.split('-');

    const dateFrom = `${year}-${month}-01`;
    const dateTo   = new Date(Number(year), Number(month), 0)
      .toISOString().slice(0, 10); // last day of month

    // Pull from Nomba Transactions API
    // GET /transactions with dateFrom, dateTo, status: success
    const response = await nombaClient.get('/transactions', {
      params: {
        dateFrom,
        dateTo,
        status: 'success',
        limit:  500,
      },
      headers: { accountId: env.NOMBA_SUB_ACCOUNT_ID },
    });

    const { code, data } = response.data;

    if (code !== '00') {
      logger.warn({ code }, '[ReconciliationJob] Nomba transactions fetch returned non-success');
      return;
    }

    const nombaTransactions: Array<{
      id:            string;
      merchantTxRef: string;
      amount:        number;
      status:        string;
      type:          string;
    }> = data?.transactions ?? [];

    logger.info({ count: nombaTransactions.length, period },
      '[ReconciliationJob] Fetched transactions from Nomba');

    let orphanCount = 0;
    let driftCount  = 0;
    let matchCount  = 0;

    for (const nTx of nombaTransactions) {
      if (!nTx.merchantTxRef) continue;

      // Look up in our local DB by nomba_tx_ref
      const local = await queryMany<{
        amount_kobo: number;
        nomba_tx_ref: string;
      }>(
        `SELECT amount_kobo, nomba_tx_ref FROM transactions
         WHERE nomba_tx_ref = $1
         UNION ALL
         SELECT amount_kobo, nomba_tx_ref FROM anonymous_transactions
         WHERE nomba_tx_ref = $1`,
        [nTx.merchantTxRef],
      );

      if (local.length === 0) {
        // Transaction exists in Nomba but NOT in our DB — orphan
        orphanCount++;
        logger.error({
          nomba_tx_ref:   nTx.merchantTxRef,
          nomba_amount:   nTx.amount,
          nomba_type:     nTx.type,
        }, '[ReconciliationJob] ORPHAN: Nomba transaction not in local DB — investigate');

        // Write an alert to a reconciliation_alerts table or send email
        await query(
          `INSERT INTO audit_log
             (actor_type, action, entity_type, metadata, created_at)
           VALUES ('SYSTEM', 'RECONCILIATION_ORPHAN', 'transaction', $1, NOW())`,
          [JSON.stringify({
            nomba_tx_ref:  nTx.merchantTxRef,
            nomba_amount:  nTx.amount,
            period,
          })],
        );
        continue;
      }

      const localTx = local[0];

      // Check amount drift
      if (Number(localTx.amount_kobo) !== nTx.amount) {
        driftCount++;
        logger.error({
          nomba_tx_ref:   nTx.merchantTxRef,
          nomba_amount:   nTx.amount,
          local_amount:   localTx.amount_kobo,
          drift:          nTx.amount - Number(localTx.amount_kobo),
        }, '[ReconciliationJob] DRIFT: Amount mismatch between Nomba and local DB');

        await query(
          `INSERT INTO audit_log
             (actor_type, action, entity_type, metadata, created_at)
           VALUES ('SYSTEM', 'RECONCILIATION_DRIFT', 'transaction', $1, NOW())`,
          [JSON.stringify({
            nomba_tx_ref:  nTx.merchantTxRef,
            nomba_amount:  nTx.amount,
            local_amount:  localTx.amount_kobo,
            period,
          })],
        );
        continue;
      }

      matchCount++;
    }

    logger.info({
      period,
      total:    nombaTransactions.length,
      matched:  matchCount,
      orphans:  orphanCount,
      drifts:   driftCount,
    }, '[ReconciliationJob] Reconciliation complete');

    if (orphanCount > 0 || driftCount > 0) {
      logger.error({
        orphans: orphanCount,
        drifts:  driftCount,
      }, '[ReconciliationJob] ACTION REQUIRED: Discrepancies found — check audit_log table');
    }

  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack },
      '[ReconciliationJob] Job failed with unhandled error');
  }
}