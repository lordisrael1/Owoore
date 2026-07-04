import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { query, queryOne } from '../src/db';
import { hashToken } from '../src/utils/crypto';

/**
 * approvals.test.ts — full integration test of the tokenised approval flow.
 *
 * Seeds a real fixture chain in the DB:
 *   org → admin (initiator) → fund → bank account → PENDING payout
 *   → 5 signatories → 5 approval tokens (valid / expired / used / …)
 *
 * Everything is cleaned up by deleting the org — every child table
 * cascades from organisations.
 *
 * NOTE on ordering: the approval endpoints are rate-limited to
 * 5 requests/minute per IP, so this file makes exactly 5 meaningful
 * requests and then asserts the 6th gets 429. Test order matters.
 */

const app = createApp();

const AMOUNT_KOBO = 5_000_000; // ₦50,000
const PHONE       = '+2348012345678';
const suffix      = Date.now();

let orgId: string;
let payoutId: string;
let sigDeclineId: string;

// Raw tokens — only the hash goes in the DB, same as production
const tokValid      = randomUUID();
const tokExpired    = randomUUID();
const tokUsed       = randomUUID();
const tokWrongPhone = randomUUID();
const tokDecline    = randomUUID();

// Generous timeout: the fixture chain is ~15 sequential inserts, and the
// remote DB proxy can add ~1s of latency to each
beforeAll(async () => {
  const org = await queryOne<{ id: string }>(
    `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Test Church ${suffix}`, `test-church-${suffix}`],
  );
  orgId = org!.id;

  const admin = await queryOne<{ id: string }>(
    `INSERT INTO admin_users (org_id, name, email, bcrypt_hash, role, is_verified)
     VALUES ($1, 'Test Treasurer', $2, 'x', 'ADMIN', TRUE) RETURNING id`,
    [orgId, `treasurer_${suffix}@test.local`],
  );

  const fund = await queryOne<{ id: string }>(
    `INSERT INTO fund_types (org_id, name) VALUES ($1, $2) RETURNING id`,
    [orgId, `Building Fund ${suffix}`],
  );

  const bank = await queryOne<{ id: string }>(
    `INSERT INTO org_bank_accounts
       (org_id, label, bank_code, bank_name, account_number, account_name, is_verified)
     VALUES ($1, 'Main Account', '058', 'GTBank', '0123456789', 'Test Church', TRUE)
     RETURNING id`,
    [orgId],
  );

  const payout = await queryOne<{ id: string }>(
    `INSERT INTO payout_requests
       (org_id, fund_type_id, bank_account_id, initiated_by,
        amount_kobo, purpose, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'Roof repairs — integration test', 'PENDING',
             NOW() + INTERVAL '48 hours')
     RETURNING id`,
    [orgId, fund!.id, bank!.id, admin!.id, AMOUNT_KOBO],
  );
  payoutId = payout!.id;

  // Ledger row with the payout amount soft-locked — decline must release it
  await query(
    `INSERT INTO fund_ledger
       (org_id, fund_type_id, total_collected_kobo, total_paid_out_kobo,
        soft_lock_kobo, period_month)
     VALUES ($1, $2, $3, 0, $4, to_char(NOW(), 'YYYY-MM'))`,
    [orgId, fund!.id, AMOUNT_KOBO * 2, AMOUNT_KOBO],
  );

  // 5 signatories — one per token scenario (UNIQUE(payout, signatory))
  const sigIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const sig = await queryOne<{ id: string }>(
      `INSERT INTO signatories (org_id, name, email, phone, role)
       VALUES ($1, $2, $3, $4, 'ELDER') RETURNING id`,
      [orgId, `Signatory ${i}`, `sig${i}_${suffix}@test.local`, PHONE],
    );
    sigIds.push(sig!.id);
  }
  sigDeclineId = sigIds[4]!;

  const insertApproval = (
    token: string, sigId: string, expiresSql: string, used: boolean,
  ) => query(
    `INSERT INTO payout_approvals
       (payout_request_id, signatory_id, token, token_hash, token_expires_at
        ${used ? ', token_used_at, action, acted_at' : ''})
     VALUES ($1, $2, $3, $4, ${expiresSql}
        ${used ? ", NOW(), 'APPROVED', NOW()" : ''})`,
    [payoutId, sigId, token, hashToken(token)],
  );

  await insertApproval(tokValid,      sigIds[0]!, `NOW() + INTERVAL '48 hours'`, false);
  await insertApproval(tokExpired,    sigIds[1]!, `NOW() - INTERVAL '1 hour'`,   false);
  await insertApproval(tokUsed,       sigIds[2]!, `NOW() + INTERVAL '48 hours'`, true);
  await insertApproval(tokWrongPhone, sigIds[3]!, `NOW() + INTERVAL '48 hours'`, false);
  await insertApproval(tokDecline,    sigIds[4]!, `NOW() + INTERVAL '48 hours'`, false);
}, 60_000);

afterAll(async () => {
  // payout_approvals.signatory_id and payout_requests.declined_by reference
  // signatories WITHOUT cascade, so delete bottom-up before the org cascade
  if (payoutId) {
    await query(`DELETE FROM payout_approvals WHERE payout_request_id = $1`, [payoutId]);
    await query(`DELETE FROM payout_requests  WHERE id = $1`, [payoutId]);
  }
  if (orgId) await query(`DELETE FROM organisations WHERE id = $1`, [orgId]);
});

describe('the tokenised approval flow (seeded)', () => {
  // Request 1/5 in the rate-limit window
  it('GET /approve/:token returns the payout details for a valid token', async () => {
    const res = await request(app).get(`/api/v1/approve/${tokValid}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payoutId).toBe(payoutId);
    expect(Number(res.body.data.amountKobo)).toBe(AMOUNT_KOBO);
    expect(res.body.data.purpose).toContain('Roof repairs');
    expect(res.body.data.orgName).toContain('Test Church');
    expect(res.body.data.bankName).toBe('GTBank');
    expect(res.body.data.alreadyActed).toBe(false);
  });

  // Request 2/5
  it('rejects an expired token with 410 TOKEN_EXPIRED', async () => {
    const res = await request(app).get(`/api/v1/approve/${tokExpired}`);

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  // Request 3/5
  it('rejects a replayed (already used) token with 410 TOKEN_USED', async () => {
    const res = await request(app)
      .post(`/api/v1/approve/${tokUsed}`)
      .send({ phone_last4: '5678' });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('TOKEN_USED');
  });

  // Request 4/5
  it('rejects an approval with the wrong phone last-4 digits', async () => {
    const res = await request(app)
      .post(`/api/v1/approve/${tokWrongPhone}`)
      .send({ phone_last4: '0000' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/phone/i);

    // Token must NOT be burned by a failed identity check
    const row = await queryOne<{ token_used_at: Date | null }>(
      `SELECT token_used_at FROM payout_approvals WHERE token = $1`,
      [tokWrongPhone],
    );
    expect(row!.token_used_at).toBeNull();
  });

  // Request 5/5
  it('decline kills the payout and releases the soft-locked funds', async () => {
    const res = await request(app)
      .post(`/api/v1/approve/${tokDecline}/decline`)
      .send({ phone_last4: '5678' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DECLINED');

    const payout = await queryOne<{ status: string; declined_by: string }>(
      `SELECT status, declined_by FROM payout_requests WHERE id = $1`,
      [payoutId],
    );
    expect(payout!.status).toBe('DECLINED');
    expect(payout!.declined_by).toBe(sigDeclineId);

    const ledger = await queryOne<{ soft_lock_kobo: string }>(
      `SELECT soft_lock_kobo FROM fund_ledger WHERE org_id = $1`,
      [orgId],
    );
    expect(Number(ledger!.soft_lock_kobo)).toBe(0);
  });

  // Request 6 — over the 5/minute budget
  it('rate-limits token scanning after 5 requests per minute', async () => {
    const res = await request(app).get(`/api/v1/approve/${tokValid}`);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});
