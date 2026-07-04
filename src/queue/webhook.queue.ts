import { PgBoss } from 'pg-boss';
import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { webhookProcessor } from '../modules/webhooks/webhook.processor';

/**
 * webhook.queue.ts — durable webhook processing on pg-boss (Postgres).
 *
 * Why a queue at all: the 200 we return to Nomba is a durability
 * contract — once Nomba sees it, the event is never resent. So the
 * event must be somewhere that survives a crash/redeploy BEFORE we
 * ACK. pg-boss stores jobs as rows in our existing Postgres (schema
 * `pgboss`), so:
 *
 *   - a Render redeploy mid-processing loses nothing — the job is a row
 *   - a processor throw is retried 5× with exponential backoff
 *   - exhausted retries land in state 'failed' — queryable with SQL,
 *     not lost in a log stream
 *
 * Why Postgres and not Redis/BullMQ: at our throughput (single-digit
 * events/sec at peak) the deciding factor is operational surface and
 * transactional locality, not raw queue speed. One database to back
 * up, and no dual-write gap between the ledger and the queue.
 *
 * NOTE ON AUDIT: the pgboss.* tables are OPERATOR plumbing (retry
 * counts, errors). The business record of every event stays in
 * webhook_log, written by the processor — whose UNIQUE constraint on
 * nomba_request_id remains the REAL idempotency guarantee. The
 * singletonKey dedupe here is only a fast-path filter.
 */

export const NOMBA_EVENTS_QUEUE = 'nomba-events';

// Guards against a HANGING database, not a slow one — a timeout surfaces
// as a 500 and Nomba retries, which is the correct fallback either way.
const ENQUEUE_TIMEOUT_MS = 5_000;

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

/** Lazily starts pg-boss exactly once per process. */
function getBoss(): Promise<PgBoss> {
  if (!startPromise) {
    startPromise = (async () => {
      // Share the app's existing pg pool instead of opening a second one —
      // Railway's connection budget is tight, and a second pool starves
      // the first (fresh connections start timing out under load).
      const boss = new PgBoss({
        db: {
          executeSql: (text: string, values?: unknown[]) =>
            pool.query(text, values as any[]),
        },
      });

      boss.on('error', (err: Error) =>
        logger.error({ err: err.message }, '[Queue] pg-boss background error'));

      await boss.start();

      // Idempotent — also carries the retry policy for every job sent here.
      // policy 'short' = one QUEUED job per singletonKey → duplicate Nomba
      // deliveries are suppressed while the first is still waiting. Every
      // send MUST carry a singletonKey (enforced by enqueueNombaEvent's
      // signature) — a key-less job would collapse dedupe queue-wide.
      await boss.createQueue(NOMBA_EVENTS_QUEUE, {
        policy:       'short',
        retryLimit:   5,
        retryDelay:   3,     // seconds; with backoff: ~3s, 6s, 12s, 24s, 48s
        retryBackoff: true,
      });

      bossInstance = boss;
      logger.info('[Queue] pg-boss started');
      return boss;
    })();
  }
  return startPromise;
}

/**
 * enqueueNombaEvent — the ONE durable write the webhook controller
 * awaits before ACKing Nomba.
 *
 * Wrapped in a hard timeout: if Postgres is hanging we fail fast with
 * a 500 so Nomba retries on its schedule, instead of eating the whole
 * ~5s webhook window with an ambiguous stall.
 *
 * Returns the job id, or null when singletonKey suppressed a duplicate
 * that is already queued — either way the event is durably held.
 */
export async function enqueueNombaEvent(
  event: Record<string, unknown>,
  requestId: string,
): Promise<string | null> {
  const boss = await getBoss();

  const send = boss.send(NOMBA_EVENTS_QUEUE, event, { singletonKey: requestId });

  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Queue enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`)),
      ENQUEUE_TIMEOUT_MS,
    );
    t.unref();
  });

  return Promise.race([send, timeout]);
}

/**
 * startWebhookWorker — registers the consumer. Called by server.ts at
 * boot (embedded mode) and by src/worker.ts (dedicated worker service).
 * Multiple consumers are safe — pg-boss fetches with SKIP LOCKED.
 *
 * A throw inside webhookProcessor.process fails the job → pg-boss
 * retries per the queue policy above. The processor itself is
 * idempotent (webhook_log unique constraint), so retries never
 * double-credit.
 */
export async function startWebhookWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.work<Record<string, unknown>>(NOMBA_EVENTS_QUEUE, async (jobs) => {
    for (const job of jobs) {
      logger.info({ job_id: job.id, nomba_request_id: (job.data as any)?.requestId },
        '[Queue] Processing webhook job');
      await webhookProcessor.process(job.data);
    }
  });

  logger.info({ queue: NOMBA_EVENTS_QUEUE }, '[Queue] Webhook worker listening');
}

/** Graceful shutdown — lets in-flight jobs finish, then closes. */
export async function stopQueue(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop();
    bossInstance = null;
    startPromise = null;
    logger.info('[Queue] pg-boss stopped');
  }
}
