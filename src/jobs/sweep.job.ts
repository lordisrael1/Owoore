import { logger } from '../utils/logger';
import { sweepService } from '../modules/payouts/sweep.service';

/**
 * sweep.job.ts — nightly auto-sweep cron.
 *
 * Runs every night at 23:00 (configurable via cron expression).
 * Finds all sweep_configs due today, checks minimum balance,
 * fires Nomba transfers for each eligible fund.
 *
 * schedule: '0 23 * * *'  → 11pm every night
 */
export async function runSweepJob(): Promise<void> {
  logger.info('[SweepJob] Starting nightly auto-sweep run');

  try {
    await sweepService.runDueSweeps();
    logger.info('[SweepJob] Sweep run completed');
  } catch (err: any) {
    logger.error({ err: err.message }, '[SweepJob] Sweep run failed');
  }
}