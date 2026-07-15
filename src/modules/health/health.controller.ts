import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { getRedisClient } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

/**
 * health.controller.ts
 *
 * GET /health — is the system healthy, and did money-processing break?
 *
 * Checks:
 *   1. database — SELECT 1 against PostgreSQL (critical: fail = down)
 *   2. nomba    — environment/base-URL sanity (no live API call)
 *   3. redis    — PING with a hard timeout (rate limits + OTP fast path
 *                 degrade gracefully without it, so fail = degraded)
 *   4. pipeline — the money-processing signals:
 *        queued          — nomba-events jobs waiting/retrying in pg-boss
 *        dead_letters    — events that exhausted every retry (money we
 *                          ACKed to Nomba but could not record!)
 *        failed_webhooks — webhook_log rows that errored in the last 24 h
 *        failed_payouts  — payout transfers that failed in the last 24 h
 *        stuck_transfers — payouts in TRANSFERRING for >1 h with no
 *                          settlement webhook (ledger drift risk)
 *
 * "The server is up" is not enough for a money product: pipeline turns
 * the response degraded whenever events or payouts stop settling, so an
 * uptime monitor on this URL doubles as a money-pipeline alarm.
 *
 * Returns 200 for ok/degraded (body carries the detail), 503 when down.
 */

interface CheckResult {
  status:  'ok' | 'fail';
  latency?: number;
  detail?:  string;
}

interface PipelineCheck extends CheckResult {
  metrics?: {
    queued:           number;
    dead_letters:     number;
    failed_webhooks_24h: number;
    failed_payouts_24h:  number;
    stuck_transfers:  number;
    reconciliation_hours_since_run: number | null;
  };
}

interface HealthStatus {
  status:   'ok' | 'degraded' | 'down';
  uptime:   number;
  ts:       string;
  version:  string;
  checks: {
    database: CheckResult;
    nomba:    CheckResult;
    redis:    CheckResult;
    pipeline: PipelineCheck;
  };
}

const REDIS_PING_TIMEOUT_MS = 1_500;

async function checkDatabase(): Promise<CheckResult> {
  try {
    const start  = Date.now();
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    return { status: 'ok', latency: Date.now() - start };
  } catch (err: any) {
    logger.error({ err: err.message }, '[Health] DB check failed');
    return { status: 'fail', detail: 'PostgreSQL unreachable' };
  }
}

function checkNomba(): CheckResult {
  const isSandbox = env.NOMBA_BASE_URL.includes('sandbox');
  if (env.NODE_ENV === 'production' && isSandbox) {
    return { status: 'fail', detail: 'Sandbox URL in production — check NOMBA_BASE_URL' };
  }
  return { status: 'ok', detail: `endpoint: ${env.NOMBA_BASE_URL}` };
}

async function checkRedis(): Promise<CheckResult> {
  try {
    const start = Date.now();
    const ping  = (async () => {
      const redis = await getRedisClient();
      await redis.ping();
    })();
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`ping timed out after ${REDIS_PING_TIMEOUT_MS}ms`)),
        REDIS_PING_TIMEOUT_MS,
      );
      t.unref();
    });
    await Promise.race([ping, timeout]);
    return { status: 'ok', latency: Date.now() - start };
  } catch (err: any) {
    logger.warn({ err: err.message }, '[Health] Redis check failed');
    return { status: 'fail', detail: 'Redis unreachable — rate limits and OTP fast path degraded' };
  }
}

/**
 * checkPipeline — one pass over the money-processing tables.
 * Any dead-lettered event or stuck transfer flips the check to fail:
 * both mean money moved (or was ACKed) without the ledger keeping up.
 */
async function checkPipeline(): Promise<PipelineCheck> {
  try {
    const start = Date.now();

    // pgboss.job only exists after the first enqueue — treat absence as empty
    const queueRows = await pool
      .query<{ name: string; n: string }>(
        `SELECT name, COUNT(*)::TEXT AS n FROM pgboss.job
         WHERE name IN ('nomba-events', 'nomba-events-dead')
           AND state IN ('created', 'retry', 'active')
         GROUP BY name`,
      )
      .then((r) => r.rows)
      .catch(() => [] as Array<{ name: string; n: string }>);

    const queued      = Number(queueRows.find((r) => r.name === 'nomba-events')?.n ?? 0);
    const deadLetters = Number(queueRows.find((r) => r.name === 'nomba-events-dead')?.n ?? 0);

    const [webhooks, payouts, stuck, reconciliation] = await Promise.all([
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::TEXT AS n FROM webhook_log
         WHERE processed = FALSE AND processing_error IS NOT NULL
           AND received_at > NOW() - INTERVAL '24 hours'`,
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::TEXT AS n FROM payout_requests
         WHERE status = 'FAILED' AND updated_at > NOW() - INTERVAL '24 hours'`,
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::TEXT AS n FROM payout_requests
         WHERE status = 'TRANSFERRING' AND updated_at < NOW() - INTERVAL '1 hour'`,
      ),
      // Written by reconciliation.job.ts on EVERY run (clean or not) — this
      // is the "did the nightly Nomba-vs-ledger diff actually run" signal.
      // A missing/stale row means the job stopped firing silently (cron
      // misconfigured, process never came back after a deploy), which
      // "no drift found" would otherwise look identical to.
      pool.query<{ hours_since: string | null }>(
        `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS hours_since
         FROM audit_log WHERE action = 'RECONCILIATION_COMPLETED'`,
      ),
    ]);

    const reconciliationHours = reconciliation.rows[0]?.hours_since;

    const metrics = {
      queued,
      dead_letters:        deadLetters,
      failed_webhooks_24h: Number(webhooks.rows[0]?.n ?? 0),
      failed_payouts_24h:  Number(payouts.rows[0]?.n ?? 0),
      stuck_transfers:     Number(stuck.rows[0]?.n ?? 0),
      reconciliation_hours_since_run: reconciliationHours === null || reconciliationHours === undefined
        ? null : Number(reconciliationHours),
    };

    // The job runs once nightly — 26h gives it a full day plus slack for
    // a slow start before flagging. null (never run even once) also fails.
    const reconciliationStale =
      metrics.reconciliation_hours_since_run === null ||
      metrics.reconciliation_hours_since_run > 26;

    // Dead letters, stuck transfers, and a stale/missing reconciliation
    // run all demand a human — surface loudly.
    const broken = metrics.dead_letters > 0 || metrics.stuck_transfers > 0 || reconciliationStale;
    if (broken) {
      logger.error({ ...metrics }, '[Health] Money pipeline check FAILED');
    }

    return {
      status:  broken ? 'fail' : 'ok',
      latency: Date.now() - start,
      metrics,
      ...(broken && {
        detail: [
          metrics.dead_letters > 0 && 'dead-lettered events',
          metrics.stuck_transfers > 0 && 'stuck transfers',
          reconciliationStale && 'reconciliation job has not completed recently',
        ].filter(Boolean).join(', ') + ' — need operator attention',
      }),
    };
  } catch (err: any) {
    logger.error({ err: err.message }, '[Health] Pipeline check errored');
    return { status: 'fail', detail: 'Pipeline check could not run' };
  }
}

export const healthController = {
  async check(_req: Request, res: Response): Promise<void> {
    const [database, redis, pipeline] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkPipeline(),
    ]);
    const nomba = checkNomba();

    // DB down = down. Anything else failing = degraded: still serving
    // traffic, but the body tells the monitor exactly what broke.
    const status: HealthStatus['status'] =
      database.status === 'fail' ? 'down'
      : [nomba, redis, pipeline].some((c) => c.status === 'fail') ? 'degraded'
      : 'ok';

    const health: HealthStatus = {
      status,
      uptime:  Math.floor(process.uptime()),
      ts:      new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
      checks:  { database, nomba, redis, pipeline },
    };

    res.status(status === 'down' ? 503 : 200).json(health);
  },
};
