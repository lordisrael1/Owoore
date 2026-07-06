import 'dotenv/config';
import { logger } from './utils/logger';
import { startWebhookWorker, startDeadLetterWorker, stopQueue } from './queue/webhook.queue';

/**
 * worker.ts — dedicated queue-worker entry point.
 *
 * The API server already runs an embedded worker (server.ts step 7),
 * which is fine at current volume. When webhook processing deserves its
 * own container (so API deploys never interrupt payment processing),
 * run this as a separate Render Background Worker:
 *
 *   Start command: npm run worker
 *
 * Running BOTH at once is safe — pg-boss fetches jobs with
 * SELECT ... FOR UPDATE SKIP LOCKED, so consumers never double-take.
 */
async function main(): Promise<void> {
  logger.info('[Worker] Starting dedicated webhook worker...');

  await startWebhookWorker();
  await startDeadLetterWorker();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '[Worker] Shutdown signal received');
    await stopQueue().catch((err) => {
      logger.warn({ err: err.message }, '[Worker] Queue stop error');
    });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Worker] Bootstrap failed:', err);
  process.exit(1);
});
