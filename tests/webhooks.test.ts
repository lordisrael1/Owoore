import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { query } from '../src/db';
import { webhookRepository } from '../src/modules/webhooks/webhook.repository';
import { stopQueue } from '../src/queue/webhook.queue';

const app = createApp();

/**
 * signEvent — computes the Nomba HMAC exactly like utils/crypto.ts:
 * HMAC-SHA256 over the colon-joined field concatenation, base64-encoded.
 */
function signEvent(payload: Record<string, any>, timestamp: string): string {
  const data        = payload?.data ?? {};
  const merchant    = data.merchant ?? {};
  const transaction = data.transaction ?? {};

  let responseCode = transaction.responseCode ?? '';
  if (responseCode === 'null') responseCode = '';

  const hashingPayload = [
    payload?.event_type ?? '',
    payload?.requestId ?? '',
    merchant.userId ?? '',
    merchant.walletId ?? '',
    transaction.transactionId ?? '',
    transaction.type ?? '',
    transaction.time ?? '',
    responseCode,
    timestamp,
  ].join(':');

  return createHmac('sha256', env.NOMBA_WEBHOOK_SECRET)
    .update(hashingPayload)
    .digest('base64');
}

const WEBHOOK_URL = '/api/v1/webhooks/nomba';

function post(_body: string) {
  return request(app).post(WEBHOOK_URL).set('Content-Type', 'application/json');
}

describe('POST /api/v1/webhooks/nomba — HMAC verification', () => {
  // payment_failed with no requestId: signature verifies, but the processor
  // no-ops (no requestId → nothing written) so the test has no side effects
  const event = {
    event_type: 'payment_failed',
    data: { transaction: { transactionId: 'tx_test_123', type: 'transfer', time: '2026-07-03' } },
  };
  const rawBody = JSON.stringify(event);

  it('rejects a request with no nomba-signature header', async () => {
    const res = await post(rawBody)
      .set('nomba-timestamp', '1234567890')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/signature/i);
  });

  it('rejects a request with no nomba-timestamp header', async () => {
    const res = await post(rawBody)
      .set('nomba-signature', 'YWJjZGVm')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/timestamp/i);
  });

  it('rejects an invalid signature', async () => {
    const res = await post(rawBody)
      .set('nomba-signature', Buffer.from('forged-signature-bytes').toString('base64'))
      .set('nomba-timestamp', '1234567890')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a correctly signed event with 200', async () => {
    const ts  = Date.now().toString();
    const sig = signEvent(event, ts);

    const res = await post(rawBody)
      .set('nomba-signature', sig)
      .set('nomba-timestamp', ts)
      .send(rawBody);

    expect(res.status).toBe(200);
  });

  it('rejects a signature computed over different field values (tamper check)', async () => {
    const ts  = Date.now().toString();
    const sig = signEvent(event, ts); // signed for transactionId tx_test_123

    const tampered = JSON.stringify({
      ...event,
      data: { transaction: { ...event.data.transaction, transactionId: 'tx_ATTACKER' } },
    });

    const res = await post(tampered)
      .set('nomba-signature', sig)
      .set('nomba-timestamp', ts)
      .send(tampered);

    expect(res.status).toBe(401);
  });

  it('rejects a valid signature replayed with a different timestamp', async () => {
    const sig = signEvent(event, '1111111111'); // signed for a different ts

    const res = await post(rawBody)
      .set('nomba-signature', sig)
      .set('nomba-timestamp', '2222222222')
      .send(rawBody);

    expect(res.status).toBe(401);
  });
});

// Generous timeouts: first enqueue starts pg-boss in-process, and the
// remote DB proxy adds seconds of connection latency in CI/dev
describe('durable enqueue — the 200 is backed by a Postgres row', { timeout: 30_000 }, () => {
  const requestId = `test_queue_${Date.now()}`;
  const event = {
    requestId,
    event_type: 'payment_failed', // worker no-ops on this type — no ledger writes
    data: { transaction: { transactionId: 'tx_queue_test', type: 'transfer', time: '2026-07-04' } },
  };
  const rawBody = JSON.stringify(event);

  beforeAll(async () => {
    // Pay the cold-start connection cost to the remote DB up front,
    // so the enqueue request itself isn't racing a TCP+TLS handshake
    await query('SELECT 1');
  }, 30_000);

  afterAll(async () => {
    await query(`DELETE FROM pgboss.job WHERE name = 'nomba-events' AND data->>'requestId' = $1`, [requestId]);
    await query(`DELETE FROM webhook_log WHERE nomba_request_id = $1`, [requestId]);
    await stopQueue();
  });

  it('ACKs only after the event is persisted as a pg-boss job', async () => {
    const ts  = Date.now().toString();
    const sig = signEvent(event, ts);

    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('Content-Type', 'application/json')
      .set('nomba-signature', sig)
      .set('nomba-timestamp', ts)
      .send(rawBody);

    expect(res.status).toBe(200);

    // The durability contract: by the time the 200 was sent, the event
    // must already exist as a row that survives a process crash
    const { rows } = await query(
      `SELECT state FROM pgboss.job WHERE name = 'nomba-events' AND data->>'requestId' = $1`,
      [requestId],
    );
    expect(rows.length).toBe(1);
  });

  it('durably holds a replayed delivery — ACKed, never lost', async () => {
    const ts  = Date.now().toString();
    const sig = signEvent(event, ts);

    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('Content-Type', 'application/json')
      .set('nomba-signature', sig)
      .set('nomba-timestamp', ts)
      .send(rawBody);

    expect(res.status).toBe(200); // duplicate still ACKed — it IS durably held

    // NOT asserting "exactly 1 pg-boss row" here: singletonKey's uniqueness
    // is a partial index scoped to state='created' (pg-boss plans.js,
    // createIndexJobPolicyShort) — the instant the first job is picked up
    // by ANY consumer it leaves that state and the slot frees up, so two
    // deliveries close together can legitimately produce 2 rows. That's
    // fine: per the architecture note in queue.ts, singletonKey is only a
    // fast-path filter, not the durability contract. The real, timing-
    // independent guarantee is webhook_log's UNIQUE(nomba_request_id),
    // covered directly below — the processor never double-credits a
    // ledger even if this fast path misses a near-simultaneous replay.
    const { rows } = await query(
      `SELECT COUNT(*)::INT AS n FROM pgboss.job WHERE name = 'nomba-events' AND data->>'requestId' = $1`,
      [requestId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('webhook idempotency — webhook_log unique constraint', () => {
  const requestId = `test_idem_${Date.now()}`;

  afterAll(async () => {
    await query(`DELETE FROM webhook_log WHERE nomba_request_id = $1`, [requestId]);
  });

  it('accepts the first delivery and flags the second as a duplicate', async () => {
    const first = await webhookRepository.logEvent({
      nomba_request_id: requestId,
      event_type:       'payment_success',
      raw_payload:      { test: true },
    });

    // First insert wins — returns the log row UUID
    expect(first).toMatch(/^[0-9a-f-]{36}$/);

    const second = await webhookRepository.logEvent({
      nomba_request_id: requestId,
      event_type:       'payment_success',
      raw_payload:      { test: true },
    });

    // Retry of the same Nomba requestId → sentinel, no second row
    expect(second).toBe('duplicate');

    const { rows } = await query(
      `SELECT COUNT(*)::INT AS n FROM webhook_log WHERE nomba_request_id = $1`,
      [requestId],
    );
    expect(rows[0].n).toBe(1);
  });
});
