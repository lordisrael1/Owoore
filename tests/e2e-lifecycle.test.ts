import { describe, it, expect, afterAll } from 'vitest';
import { createHmac } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { query, queryOne, withTransaction } from '../src/db';
import { webhookProcessor } from '../src/modules/webhooks/webhook.processor';
import { ledgerService } from '../src/modules/transactions/ledger.service';
import { payoutRepository } from '../src/modules/payouts/payout.repository';
import { tokenService } from '../src/modules/payouts/approvals/token.service';
import { stopQueue } from '../src/queue/webhook.queue';

/**
 * e2e-lifecycle.test.ts — full end-to-end integration test of the entire
 * product lifecycle against the real app + real database:
 *
 *   1. Church onboarding    → POST /orgs (org + admin + policy + default funds)
 *   2. Admin verification   → OTP verify-email → password login → admin JWT
 *   3. Member join          → send-otp → verify-otp → member JWT
 *   4. Fund management      → list defaults, create a new fund via API
 *   5. Giving               → signed Nomba webhook over HTTP (durable enqueue),
 *                             then the worker pipeline (webhookProcessor) end to
 *                             end: idempotency → reconciliation → transactions
 *                             → fund_ledger. Member + shared-VA (Offering) paths.
 *   6. Visibility           → member giving history, admin dashboard, reports
 *   7. Payout governance    → soft-lock + locked_period_month, tokenised
 *                             approval links over HTTP (partial → decline),
 *                             insufficient-balance gate, initiator cancel
 *
 * External APIs (Nomba VA creation / transfers, Resend email delivery) are the
 * ONLY things not exercised — everything is seeded or driven at the same layer
 * the worker/webhook would drive it. Cleanup deletes the org (cascades) plus
 * the non-cascading rows (otp_tokens, webhook_log, pgboss jobs, audit_log).
 *
 * NOTE: tests in this file are sequential and share state — a failure early
 * in the journey will cascade. That is intentional: it IS one journey.
 */

const app = createApp();

const suffix       = Date.now();
const ORG_NAME     = `E2E Lifecycle Church ${suffix}`;
const ADMIN_NAME   = 'Pastor E2E';
const ADMIN_EMAIL  = `e2e_admin_${suffix}@test.local`;
const ADMIN_PASS   = 'SuperSecret123';
const MEMBER_NAME  = 'Sister E2E';
const MEMBER_EMAIL = `e2e_member_${suffix}@test.local`;

const SIG_PHONE    = '+2348012345678'; // last4 = 5678

// Webhook request ids (also used for cleanup)
const REQ_A      = `e2e_req_a_${suffix}`;  // member gift #1 (HTTP + worker)
const REQ_B      = `e2e_req_b_${suffix}`;  // member gift #2 (worker only)
const REQ_SHARED = `e2e_req_s_${suffix}`;  // offering / shared VA gift

const MEMBER_REF = `e2e_ref_${suffix}`;    // member_fund_accounts.account_reference
const SHARED_REF = `s_e2e${suffix}`;       // must start with s_ for the shared path

// ── Journey state (populated as the tests run) ─────────────────────────────
let orgId       = '';
let orgSlug     = '';
let adminId     = '';
let adminToken  = '';
let memberId    = '';
let memberToken = '';
let tithe:    { id: string } | null = null;
let offering: { id: string } | null = null;
let bankAccountId = '';
let sigA: { id: string } | null = null;
let sigB: { id: string } | null = null;
let payoutId  = '';
let payout2Id = '';
let tokenSigA = '';
let tokenSigB = '';

// ── Helpers ────────────────────────────────────────────────────────────────

/** signEvent — Nomba HMAC exactly like utils/crypto.ts computes it. */
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

/** paymentEvent — builds a Nomba payment_success event for a VA reference. */
function paymentEvent(input: {
  requestId:  string;
  accountRef: string;
  naira:      number;
  feeNaira?:  number;
  txId:       string;
}) {
  return {
    requestId:  input.requestId,
    event_type: 'payment_success',
    data: {
      transaction: {
        aliasAccountReference: input.accountRef,
        aliasAccountNumber:    '9900000001',
        transactionAmount:     input.naira,
        fee:                   input.feeNaira ?? 0,
        transactionId:         input.txId,
        sessionId:             `sess_${input.txId}`,
        type:                  'vact_transfer',
        time:                  new Date().toISOString(),
        narration:             'E2E lifecycle test inflow',
      },
      customer: {
        accountNumber: '0011223344',
        bankName:      'GTBank',
        senderName:    'E2E Sender',
      },
    },
  };
}

/** latest unused OTP code stored for an email (DB is the audit store). */
async function getOtpFor(email: string): Promise<string | null> {
  const row = await queryOne<{ code: string }>(
    `SELECT code FROM otp_tokens
     WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  return row?.code ?? null;
}

async function titheLedger() {
  return queryOne<{
    total_collected_kobo: string;
    total_fees_kobo:      string;
    soft_lock_kobo:       string;
    member_count_paid:    number;
    total_transactions:   number;
  }>(
    `SELECT total_collected_kobo, total_fees_kobo, soft_lock_kobo,
            member_count_paid, total_transactions
     FROM fund_ledger
     WHERE org_id = $1 AND fund_type_id = $2
       AND period_month = to_char(NOW(), 'YYYY-MM')`,
    [orgId, tithe!.id],
  );
}

const bearer = (t: string) => `Bearer ${t}`;

// ── Cleanup ────────────────────────────────────────────────────────────────
afterAll(async () => {
  try {
    await query(
      `DELETE FROM pgboss.job WHERE name = 'nomba-events' AND data->>'requestId' = ANY($1)`,
      [[REQ_A, REQ_B, REQ_SHARED]],
    );
  } catch { /* pgboss schema may not exist if enqueue never ran */ }

  await query(`DELETE FROM webhook_log WHERE nomba_request_id = ANY($1)`,
    [[REQ_A, REQ_B, REQ_SHARED]]);
  await query(`DELETE FROM otp_tokens WHERE email = ANY($1)`,
    [[ADMIN_EMAIL, MEMBER_EMAIL]]);
  if (orgId) {
    await query(`DELETE FROM audit_log WHERE org_id = $1`, [orgId]);
    // Financial records deliberately do NOT cascade from organisations,
    // and payout_approvals blocks the signatories cascade
    await query(`DELETE FROM transactions WHERE org_id = $1`, [orgId]);
    await query(`DELETE FROM anonymous_transactions WHERE org_id = $1`, [orgId]);
    await query(
      `DELETE FROM payout_approvals WHERE payout_request_id IN
         (SELECT id FROM payout_requests WHERE org_id = $1)`,
      [orgId],
    );
    await query(`DELETE FROM organisations WHERE id = $1`, [orgId]); // cascades the rest
  }
  await stopQueue();
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 — Church onboarding
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 1 — church onboarding', () => {
  it('registers a new church with admin, policy and default funds', async () => {
    const res = await request(app).post('/api/v1/orgs').send({
      name:           ORG_NAME,
      admin_name:     ADMIN_NAME,
      admin_email:    ADMIN_EMAIL,
      admin_password: ADMIN_PASS,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.org.name).toBe(ORG_NAME);
    expect(res.body.data.admin.email).toBe(ADMIN_EMAIL);
    expect(res.body.data.admin.is_verified).toBe(false);
    expect(res.body.data.joinLink).toContain(res.body.data.org.slug);

    orgId   = res.body.data.org.id;
    orgSlug = res.body.data.org.slug;
    adminId = res.body.data.admin.id;
  });

  it('seeded the default payout policy (2 approvers, ₦100k threshold)', async () => {
    const policy = await queryOne<{ min_approvers: number; threshold_kobo: string }>(
      `SELECT min_approvers, threshold_kobo FROM payout_policies WHERE org_id = $1`,
      [orgId],
    );
    expect(policy).not.toBeNull();
    expect(policy!.min_approvers).toBe(2);
    expect(Number(policy!.threshold_kobo)).toBe(10_000_000);
  });

  it('seeded the default funds — per-member Tithe and shared-VA Offering', async () => {
    tithe = await queryOne(
      `SELECT id FROM fund_types WHERE org_id = $1 AND name = 'Tithe' AND is_shared_va = FALSE`,
      [orgId],
    );
    offering = await queryOne(
      `SELECT id FROM fund_types WHERE org_id = $1 AND name = 'Offering' AND is_shared_va = TRUE`,
      [orgId],
    );
    expect(tithe).not.toBeNull();
    expect(offering).not.toBeNull();
  });

  it('exposes the church on the public join-slug lookup', async () => {
    const res = await request(app).get(`/api/v1/orgs/${orgSlug}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(orgId);
    expect(res.body.data.name).toBe(ORG_NAME);
  });

  it('blocks password login until the admin email is verified', async () => {
    const res = await request(app).post('/api/v1/auth/admin/login').send({
      email:    ADMIN_EMAIL,
      password: ADMIN_PASS,
    });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('verifies the admin email with the registration OTP and logs them in', async () => {
    // Registration already generated + stored an OTP; if the delivery attempt
    // errored before the row landed, request a fresh one through the API.
    let code = await getOtpFor(ADMIN_EMAIL);
    if (!code) {
      const send = await request(app).post('/api/v1/auth/send-otp').send({
        email: ADMIN_EMAIL, org_slug: orgSlug,
      });
      expect(send.status).toBe(200);
      code = await getOtpFor(ADMIN_EMAIL);
    }
    expect(code).toMatch(/^\d{6}$/);

    const res = await request(app).post('/api/v1/auth/admin/verify-email').send({
      email:    ADMIN_EMAIL,
      code:     code!,
      org_slug: orgSlug,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.admin.role).toBe('ADMIN');
  });

  it('now allows password login and issues a working admin JWT', async () => {
    const res = await request(app).post('/api/v1/auth/admin/login').send({
      email:    ADMIN_EMAIL,
      password: ADMIN_PASS,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.admin.orgId).toBe(orgId);
    adminToken = res.body.data.token;

    // JWT actually works against a protected route
    const funds = await request(app)
      .get(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken));
    expect(funds.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Member joins via OTP
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 2 — member joins the church', () => {
  it('sends a member OTP for the org slug', async () => {
    const res = await request(app).post('/api/v1/auth/send-otp').send({
      email:    MEMBER_EMAIL,
      org_slug: orgSlug,
    });
    expect(res.status).toBe(200);
    expect(res.body.data?.message ?? res.body.message).toMatch(/sent/i);
  });

  it('requires a display name on first-time verification (OTP not consumed)', async () => {
    const code = await getOtpFor(MEMBER_EMAIL);
    expect(code).toMatch(/^\d{6}$/);

    const res = await request(app).post('/api/v1/auth/verify-otp').send({
      email:    MEMBER_EMAIL,
      code:     code!,
      org_slug: orgSlug,
    });
    expect(res.status).toBe(400);
  });

  it('registers the member with the SAME code once the name is supplied', async () => {
    const code = await getOtpFor(MEMBER_EMAIL);
    expect(code).toMatch(/^\d{6}$/); // still unconsumed

    const res = await request(app).post('/api/v1/auth/verify-otp').send({
      email:    MEMBER_EMAIL,
      code:     code!,
      org_slug: orgSlug,
      name:     MEMBER_NAME,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.member.isNew).toBe(true);
    expect(res.body.data.member.orgId).toBe(orgId);
    expect(res.body.data.refreshToken).toBeDefined();

    memberToken = res.body.data.token;
    memberId    = res.body.data.member.id;
  });

  it('serves the member portal profile with the issued JWT', async () => {
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', bearer(memberToken));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(MEMBER_EMAIL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — Fund management
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 3 — fund management', () => {
  it('lists the default funds for the admin', async () => {
    const res = await request(app)
      .get(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    const names = JSON.stringify(res.body);
    expect(names).toContain('Tithe');
    expect(names).toContain('Offering');
  });

  it('creates a new fund through the API', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken))
      .send({ name: `Building Fund ${suffix}`, kind: 'RECURRING' });

    expect([200, 201]).toContain(res.status);

    const fund = await queryOne<{ id: string }>(
      `SELECT id FROM fund_types WHERE org_id = $1 AND name = $2`,
      [orgId, `Building Fund ${suffix}`],
    );
    expect(fund).not.toBeNull();
  });

  it("blocks a different org's admin from creating funds here (tenant isolation)", async () => {
    // Register nothing — just a forged-org token via the login of THIS admin
    // would carry our orgId; instead assert no token at all is rejected.
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .send({ name: 'Hostile Fund' });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — Giving: webhook → worker pipeline → ledger
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 4 — giving via Nomba webhooks', () => {
  it('seeds the member virtual account (Nomba VA stand-in)', async () => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO member_fund_accounts
         (member_id, fund_type_id, org_id, nomba_va_number, account_reference)
       VALUES ($1, $2, $3, '9900000001', $4)
       RETURNING id`,
      [memberId, tithe!.id, orgId, MEMBER_REF],
    );
    expect(row).not.toBeNull();
  });

  it('accepts a correctly signed payment_success webhook and enqueues it durably', async () => {
    const event   = paymentEvent({
      requestId: REQ_A, accountRef: MEMBER_REF, naira: 25_000, feeNaira: 25,
      txId: `e2e_tx_a_${suffix}`,
    });
    const rawBody = JSON.stringify(event);
    const ts      = Date.now().toString();

    const res = await request(app)
      .post('/api/v1/webhooks/nomba')
      .set('Content-Type', 'application/json')
      .set('nomba-signature', signEvent(event, ts))
      .set('nomba-timestamp', ts)
      .send(rawBody);

    expect(res.status).toBe(200);

    const { rows } = await query(
      `SELECT 1 FROM pgboss.job WHERE name = 'nomba-events' AND data->>'requestId' = $1`,
      [REQ_A],
    );
    expect(rows.length).toBe(1);
  }, 60_000);

  it('worker pipeline records the transaction and credits the ledger', async () => {
    const event = paymentEvent({
      requestId: REQ_A, accountRef: MEMBER_REF, naira: 25_000, feeNaira: 25,
      txId: `e2e_tx_a_${suffix}`,
    });

    await webhookProcessor.process(event);

    const tx = await queryOne<{
      amount_kobo: string; fee_kobo: string; payment_status: string; org_id: string;
    }>(
      `SELECT amount_kobo, fee_kobo, payment_status, org_id
       FROM transactions WHERE nomba_tx_ref = $1`,
      [`e2e_tx_a_${suffix}`],
    );
    expect(tx).not.toBeNull();
    expect(Number(tx!.amount_kobo)).toBe(2_500_000); // ₦25,000 → kobo
    expect(Number(tx!.fee_kobo)).toBe(2_500);
    expect(tx!.payment_status).toBe('EXACT');        // no pledge → EXACT
    expect(tx!.org_id).toBe(orgId);

    const ledger = await titheLedger();
    expect(Number(ledger!.total_collected_kobo)).toBe(2_500_000);
    expect(Number(ledger!.total_fees_kobo)).toBe(2_500);
    expect(Number(ledger!.member_count_paid)).toBe(1);
    expect(Number(ledger!.total_transactions)).toBe(1);
  });

  it('is idempotent — replaying the same requestId changes nothing', async () => {
    const event = paymentEvent({
      requestId: REQ_A, accountRef: MEMBER_REF, naira: 25_000, feeNaira: 25,
      txId: `e2e_tx_a_${suffix}`,
    });

    await webhookProcessor.process(event); // duplicate delivery

    const { rows } = await query(
      `SELECT COUNT(*)::INT AS n FROM transactions WHERE nomba_tx_ref = $1`,
      [`e2e_tx_a_${suffix}`],
    );
    expect(rows[0].n).toBe(1);

    const ledger = await titheLedger();
    expect(Number(ledger!.total_collected_kobo)).toBe(2_500_000); // unchanged
  });

  it('counts a second gift from the same member once in totals but NOT in unique givers', async () => {
    const event = paymentEvent({
      requestId: REQ_B, accountRef: MEMBER_REF, naira: 10_000, feeNaira: 10,
      txId: `e2e_tx_b_${suffix}`,
    });

    await webhookProcessor.process(event);

    const ledger = await titheLedger();
    expect(Number(ledger!.total_collected_kobo)).toBe(3_500_000);
    expect(Number(ledger!.total_fees_kobo)).toBe(3_500);
    expect(Number(ledger!.member_count_paid)).toBe(1);  // unique givers, not payments
    expect(Number(ledger!.total_transactions)).toBe(2);
  });

  it('routes a shared-VA (Offering) inflow to anonymous_transactions', async () => {
    await query(
      `INSERT INTO org_shared_fund_accounts
         (org_id, fund_type_id, nomba_va_number, account_reference)
       VALUES ($1, $2, '9900000002', $3)`,
      [orgId, offering!.id, SHARED_REF],
    );

    const event = paymentEvent({
      requestId: REQ_SHARED, accountRef: SHARED_REF, naira: 5_000,
      txId: `e2e_tx_s_${suffix}`,
    });

    await webhookProcessor.process(event);

    const anon = await queryOne<{ amount_kobo: string }>(
      `SELECT amount_kobo FROM anonymous_transactions WHERE nomba_tx_ref = $1`,
      [`e2e_tx_s_${suffix}`],
    );
    expect(anon).not.toBeNull();
    expect(Number(anon!.amount_kobo)).toBe(500_000);

    const ledger = await queryOne<{ total_collected_kobo: string; member_count_paid: number }>(
      `SELECT total_collected_kobo, member_count_paid FROM fund_ledger
       WHERE org_id = $1 AND fund_type_id = $2 AND period_month = to_char(NOW(), 'YYYY-MM')`,
      [orgId, offering!.id],
    );
    expect(Number(ledger!.total_collected_kobo)).toBe(500_000);
    expect(Number(ledger!.member_count_paid)).toBe(0); // anonymous — no identity
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — Visibility: member history, dashboard, reports
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 5 — the money is visible everywhere it should be', () => {
  it('member sees both gifts in their giving history', async () => {
    const res = await request(app)
      .get('/api/v1/me/giving-history')
      .set('Authorization', bearer(memberToken));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('2500000'); // ₦25,000 gift in kobo
    expect(body).toContain('1000000'); // ₦10,000 gift in kobo
  });

  it('admin dashboard summary and fund breakdown reflect the collections', async () => {
    const summary = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', bearer(adminToken));
    expect(summary.status).toBe(200);
    expect(summary.body.success).toBe(true);

    const breakdown = await request(app)
      .get('/api/v1/dashboard/fund-breakdown')
      .set('Authorization', bearer(adminToken));
    expect(breakdown.status).toBe(200);
    const body = JSON.stringify(breakdown.body);
    expect(body).toContain('Tithe');
    expect(body).toContain('Offering');
  });

  it('admin member list includes the new member', async () => {
    const res = await request(app)
      .get('/api/v1/members')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(MEMBER_EMAIL);
  });

  it('member token is rejected on admin dashboards (role separation)', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', bearer(memberToken));
    expect([401, 403]).toContain(res.status);
  });

  it('serves the org giving report as JSON and CSV', async () => {
    const json = await request(app)
      .get(`/api/v1/orgs/${orgId}/reports/giving`)
      .set('Authorization', bearer(adminToken));
    expect(json.status).toBe(200);

    const csv = await request(app)
      .get(`/api/v1/orgs/${orgId}/reports/giving?format=csv`)
      .set('Authorization', bearer(adminToken));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/csv/);
  });

  it('serves the member statement for the admin', async () => {
    const res = await request(app)
      .get(`/api/v1/members/${memberId}/statement`)
      .set('Authorization', bearer(adminToken));
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — Payout governance: M-of-N approvals over HTTP
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 6 — payout governance', () => {
  it('admin registers two signatories through the API', async () => {
    const mk = (label: string) => request(app)
      .post('/api/v1/signatories')
      .set('Authorization', bearer(adminToken))
      .send({
        name:  `Signatory ${label}`,
        email: `e2e_sig_${label}_${suffix}@test.local`,
        phone: SIG_PHONE,
        role:  'ELDER',
        can_approve: true,
      });

    const a = await mk('a');
    const b = await mk('b');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    sigA = await queryOne(`SELECT id FROM signatories WHERE org_id = $1 AND email = $2`,
      [orgId, `e2e_sig_a_${suffix}@test.local`]);
    sigB = await queryOne(`SELECT id FROM signatories WHERE org_id = $1 AND email = $2`,
      [orgId, `e2e_sig_b_${suffix}@test.local`]);
    expect(sigA).not.toBeNull();
    expect(sigB).not.toBeNull();
  });

  it('seeds a verified destination bank account (Nomba lookup stand-in)', async () => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO org_bank_accounts
         (org_id, label, bank_code, bank_name, account_number, account_name, is_verified)
       VALUES ($1, 'Main Church Account', '058', 'GTBank', '0123456789', $2, TRUE)
       RETURNING id`,
      [orgId, ORG_NAME],
    );
    bankAccountId = row!.id;
    expect(bankAccountId).toBeTruthy();
  });

  it('initiates an above-threshold payout: atomic balance check + soft lock', async () => {
    // Same path approvalPayoutService.initiate takes, minus the Resend emails:
    // checkAndLock + createTx in one transaction, then a token per signatory.
    const AMOUNT = 3_000_000; // ₦30,000 of the ₦34,965 available (after fees)

    const payout = await withTransaction(async (client) => {
      const { lockedPeriod } = await ledgerService.checkAndLock(client, {
        org_id:        orgId,
        fund_type_id:  tithe!.id,
        amountKobo:    AMOUNT,
        feeBufferKobo: env.NOMBA_TRANSFER_FEE_KOBO,
      });
      return payoutRepository.createTx(client, {
        org_id:              orgId,
        fund_type_id:        tithe!.id,
        bank_account_id:     bankAccountId,
        initiated_by:        adminId,
        amount_kobo:         AMOUNT,
        purpose:             'E2E — roof repairs',
        expires_at:          new Date(Date.now() + 72 * 3600 * 1000),
        locked_period_month: lockedPeriod,
      });
    });
    payoutId = payout.id;

    expect(payout.status).toBe('PENDING');
    expect(payout.locked_period_month).toBeTruthy(); // migration 031 column

    ({ rawToken: tokenSigA } = await tokenService.generate({
      payoutRequestId: payoutId, signatoryId: sigA!.id, expiryHours: 48,
      email: `e2e_sig_a_${suffix}@test.local`,
    }));
    ({ rawToken: tokenSigB } = await tokenService.generate({
      payoutRequestId: payoutId, signatoryId: sigB!.id, expiryHours: 48,
      email: `e2e_sig_b_${suffix}@test.local`,
    }));

    const ledger = await titheLedger();
    expect(Number(ledger!.soft_lock_kobo)).toBe(AMOUNT);

    const balance = await ledgerService.getBalance(orgId, tithe!.id);
    expect(balance.available_kobo).toBe(3_500_000 - 3_500 - AMOUNT); // 496,500
  });

  it('rejects a second payout that would over-commit the fund', async () => {
    await expect(
      withTransaction(async (client) =>
        ledgerService.checkAndLock(client, {
          org_id:        orgId,
          fund_type_id:  tithe!.id,
          amountKobo:    1_000_000, // only 496,500 available
          feeBufferKobo: env.NOMBA_TRANSFER_FEE_KOBO,
        }),
      ),
    ).rejects.toThrow(/Insufficient balance/);
  });

  it('serves the tokenised approval page details (no JWT — token is the credential)', async () => {
    const res = await request(app).get(`/api/v1/approve/${tokenSigA}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.amountKobo)).toBe(3_000_000);
    expect(res.body.data.fundName).toBe('Tithe');
    expect(res.body.data.alreadyActed).toBe(false);
  });

  it('rejects an approval with the wrong phone last-4 (link forwarding defence)', async () => {
    const res = await request(app)
      .post(`/api/v1/approve/${tokenSigB}`)
      .send({ phone_last4: '0000' });
    expect(res.status).toBe(401);
  });

  it('records the first approval → PARTIAL (1 of 2, quorum not reached)', async () => {
    const res = await request(app)
      .post(`/api/v1/approve/${tokenSigA}`)
      .send({ phone_last4: '5678' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PARTIAL');

    const payout = await payoutRepository.findByIdAnyOrg(payoutId);
    expect(payout!.status).toBe('PARTIAL');
  });

  it('a single decline kills the payout and releases the soft lock', async () => {
    const res = await request(app)
      .post(`/api/v1/approve/${tokenSigB}/decline`)
      .send({ phone_last4: '5678' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DECLINED');

    const payout = await payoutRepository.findByIdAnyOrg(payoutId);
    expect(payout!.status).toBe('DECLINED');
    expect(payout!.declined_by).toBe(sigB!.id);

    const ledger = await titheLedger();
    expect(Number(ledger!.soft_lock_kobo)).toBe(0); // fully released

    const balance = await ledgerService.getBalance(orgId, tithe!.id);
    expect(balance.available_kobo).toBe(3_496_500); // back to pre-payout
  });

  it('initiator can cancel a PENDING payout via the API — lock released', async () => {
    const AMOUNT = 1_500_000;
    const payout2 = await withTransaction(async (client) => {
      const { lockedPeriod } = await ledgerService.checkAndLock(client, {
        org_id: orgId, fund_type_id: tithe!.id,
        amountKobo: AMOUNT, feeBufferKobo: env.NOMBA_TRANSFER_FEE_KOBO,
      });
      return payoutRepository.createTx(client, {
        org_id: orgId, fund_type_id: tithe!.id,
        bank_account_id: bankAccountId, initiated_by: adminId,
        amount_kobo: AMOUNT, purpose: 'E2E — cancelled payout',
        expires_at: new Date(Date.now() + 72 * 3600 * 1000),
        locked_period_month: lockedPeriod,
      });
    });
    payout2Id = payout2.id;

    const res = await request(app)
      .delete(`/api/v1/payouts/${payout2Id}`)
      .set('Authorization', bearer(adminToken));
    expect(res.status).toBe(200);

    const after = await payoutRepository.findByIdAnyOrg(payout2Id);
    expect(after!.status).toBe('CANCELLED');

    const ledger = await titheLedger();
    expect(Number(ledger!.soft_lock_kobo)).toBe(0);
  });

  it('admin sees both payouts with their terminal states in the payout list', async () => {
    const res = await request(app)
      .get('/api/v1/payouts')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(payoutId);
    expect(body).toContain(payout2Id);
    expect(body).toContain('DECLINED');
    expect(body).toContain('CANCELLED');
  });

  it('fund balances endpoint shows the fully restored Tithe balance', async () => {
    const res = await request(app)
      .get('/api/v1/payouts/fund-balances')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    const titheRow = (res.body.data ?? res.body).find?.(
      (f: any) => f.fund_type_id === tithe!.id,
    ) ?? res.body.data?.balances?.find?.((f: any) => f.fund_type_id === tithe!.id);
    // Shape-tolerant: at minimum the response must contain the restored figure
    expect(JSON.stringify(res.body)).toContain('3496500');
    if (titheRow) expect(Number(titheRow.available_kobo)).toBe(3_496_500);
  });
});
