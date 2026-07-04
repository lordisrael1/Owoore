import 'dotenv/config';
import { createApp }       from './app';
import { testConnection }  from './config/database';
import { initNomba }       from './config/nomba';
import { testResendConnection } from './config/resend';
import { warmBankCache }   from './modules/payouts/bank-lookup.service';
import { startScheduler }  from './jobs/scheduler';
import { startWebhookWorker, stopQueue } from './queue/webhook.queue';
import { env }             from './config/env';
import { logger }          from './utils/logger';

/**
 * server.ts — HTTP server entry point.
 *
 * Startup sequence (order matters):
 *   1. Validate environment variables (env.ts throws on missing)
 *   2. Test PostgreSQL connection
 *   3. Fetch initial Nomba auth token (55-min refresh configured)
 *   4. Verify Resend API key
 *   5. Pre-warm Nomba bank list cache
 *   6. Start Express HTTP server
 *   7. Register cron job scheduler
 *
 * Graceful shutdown:
 *   SIGTERM / SIGINT → stop cron jobs → close HTTP server → pool drains
 *   Railway sends SIGTERM on deploy — we handle it cleanly.
 */

async function bootstrap(): Promise<void> {
  logger.info('[Server] Starting Owoore backend...');
  logger.info({ env: env.NODE_ENV, port: env.PORT }, '[Server] Environment loaded');

  // ── Step 1: Database ──────────────────────────────────────────────────
  await testConnection();

  // ── Step 2: Nomba auth token ──────────────────────────────────────────
  await initNomba();

  // ── Step 3: Resend email client ───────────────────────────────────────
  await testResendConnection();

  // ── Step 4: Pre-warm bank list cache (non-blocking) ───────────────────
  // Prevents first payout from paying the Nomba bank-list fetch penalty
  warmBankCache().catch(() => {
    logger.warn('[Server] Bank cache warm failed — will fetch on first payout');
  });

  // ── Step 5: Start HTTP server ─────────────────────────────────────────
  const app    = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({
      port:    env.PORT,
      health:  `http://localhost:${env.PORT}/health`,
      webhooks: `http://localhost:${env.PORT}/api/v1/webhooks/nomba`,
    }, '[Server] HTTP server listening');
  });

  // ── Step 6: Start job scheduler ───────────────────────────────────────
  const stopScheduler = startScheduler();

  // ── Step 7: Start webhook queue worker (pg-boss, embedded) ───────────
  // Runs in-process by default; can also run as a dedicated service via
  // `npm run worker` — pg-boss handles multiple consumers safely.
  await startWebhookWorker();

  // ── Graceful shutdown ─────────────────────────────────────────────────
  // Railway sends SIGTERM ~10s before forceful kill on deploy
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '[Server] Shutdown signal received');

    // 1. Stop accepting new requests
    server.close((err) => {
      if (err) {
        logger.error({ err: err.message }, '[Server] HTTP server close error');
      } else {
        logger.info('[Server] HTTP server closed');
      }
    });

    // 2. Stop cron jobs
    stopScheduler();

    // 3. Stop the queue worker — lets in-flight webhook jobs finish
    await stopQueue().catch((err) => {
      logger.warn({ err: err.message }, '[Server] Queue stop error');
    });

    // 4. pg Pool drains automatically via process.on handlers in database.ts
    logger.info('[Server] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Catch uncaught exceptions — log and exit cleanly
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, '[Server] Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '[Server] Unhandled promise rejection');
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('[Server] Bootstrap failed:', err);
  process.exit(1);
});