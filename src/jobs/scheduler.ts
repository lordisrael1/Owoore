import cron from 'node-cron';
import { logger } from '../utils/logger';
import { runSweepJob }           from './sweep.job';
import { runReconciliationJob }  from './reconciliation.job';
import { runExpiryJob }          from './expiry.job';
import { runReminderJob }        from './reminder.job';

/**
 * scheduler.ts — registers all cron jobs.
 *
 * Called by server.ts on startup. Returns a cleanup function
 * for graceful shutdown — all jobs are stopped before process exits.
 *
 * Job schedule:
 *   expiry.job       → every hour at :00         '0 * * * *'
 *   sweep.job        → every night at 23:00       '0 23 * * *'
 *   reconciliation   → every night at 02:00       '0 2 * * *'
 *   reminder.job     → every Monday at 09:00      '0 9 * * 1'
 */

interface ScheduledJob {
  name:     string;
  schedule: string;
  task:     cron.ScheduledTask;
}

const jobs: ScheduledJob[] = [];

export function startScheduler(): () => void {
  logger.info('[Scheduler] Registering cron jobs');

  // ── Expiry (hourly) ─────────────────────────────────────────────────
  jobs.push({
    name:     'expiry',
    schedule: '0 * * * *',
    task:     cron.schedule('0 * * * *', async () => {
      try { await runExpiryJob(); }
      catch (err: any) { logger.error({ err: err.message }, '[Scheduler] expiry.job uncaught error'); }
    }, { timezone: 'Africa/Lagos' }),
  });

  // ── Auto-sweep (nightly 11pm) ────────────────────────────────────────
  jobs.push({
    name:     'sweep',
    schedule: '0 23 * * *',
    task:     cron.schedule('0 23 * * *', async () => {
      try { await runSweepJob(); }
      catch (err: any) { logger.error({ err: err.message }, '[Scheduler] sweep.job uncaught error'); }
    }, { timezone: 'Africa/Lagos' }),
  });

  // ── Reconciliation (nightly 2am) — CRITICAL ──────────────────────────
  jobs.push({
    name:     'reconciliation',
    schedule: '0 2 * * *',
    task:     cron.schedule('0 2 * * *', async () => {
      try { await runReconciliationJob(); }
      catch (err: any) { logger.error({ err: err.message }, '[Scheduler] reconciliation.job uncaught error'); }
    }, { timezone: 'Africa/Lagos' }),
  });

  // ── Member reminders (Monday 9am) ────────────────────────────────────
  jobs.push({
    name:     'reminder',
    schedule: '0 9 * * 1',
    task:     cron.schedule('0 9 * * 1', async () => {
      try { await runReminderJob(); }
      catch (err: any) { logger.error({ err: err.message }, '[Scheduler] reminder.job uncaught error'); }
    }, { timezone: 'Africa/Lagos' }),
  });

  logger.info({
    jobs: jobs.map((j) => ({ name: j.name, schedule: j.schedule })),
  }, '[Scheduler] All jobs registered');

  // Return cleanup function for graceful shutdown
  return function stopScheduler(): void {
    logger.info('[Scheduler] Stopping all cron jobs');
    jobs.forEach((j) => {
      j.task.stop();
      logger.debug({ job: j.name }, '[Scheduler] Job stopped');
    });
  };
}