import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { query, queryOne } from '../src/db';
import { adminUserRepository } from '../src/modules/admin-users/admin-users.repository';

/**
 * sweep.test.ts — the system-actor plumbing behind auto-sweeps.
 *
 * payout_requests.initiated_by is NOT NULL REFERENCES admin_users(id),
 * so sweeps attribute to a designated per-org 'SYSTEM' admin row.
 * These tests pin down its invariants: idempotent creation, no login
 * capability, and FK-compatibility with payout_requests.
 */

const app = createApp();
const suffix = Date.now();

let orgId: string;

beforeAll(async () => {
  const org = await queryOne<{ id: string }>(
    `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Sweep Test Church ${suffix}`, `sweep-test-church-${suffix}`],
  );
  orgId = org!.id;
});

afterAll(async () => {
  if (orgId) await query(`DELETE FROM organisations WHERE id = $1`, [orgId]);
});

describe('designated system actor', () => {
  it('is created on first use and reused on every call after', async () => {
    const first  = await adminUserRepository.getOrCreateSystemActor(orgId);
    const second = await adminUserRepository.getOrCreateSystemActor(orgId);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);

    const { rows } = await query(
      `SELECT COUNT(*)::INT AS n FROM admin_users
       WHERE org_id = $1 AND email = 'system@owoore.internal'`,
      [orgId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('can never log in — no password, inactive, role SYSTEM', async () => {
    const actorId = await adminUserRepository.getOrCreateSystemActor(orgId);

    const row = await queryOne<{
      bcrypt_hash: string | null; is_active: boolean; role: string;
    }>(
      `SELECT bcrypt_hash, is_active, role FROM admin_users WHERE id = $1`,
      [actorId],
    );

    expect(row!.bcrypt_hash).toBeNull();
    expect(row!.is_active).toBe(false);
    expect(row!.role).toBe('SYSTEM');

    // The login endpoint must reject it outright
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .send({ email: 'system@owoore.internal', password: 'anything-at-all' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('satisfies the payout_requests.initiated_by foreign key', async () => {
    const actorId = await adminUserRepository.getOrCreateSystemActor(orgId);

    const fund = await queryOne<{ id: string }>(
      `INSERT INTO fund_types (org_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, `Sweep Fund ${suffix}`],
    );
    const bank = await queryOne<{ id: string }>(
      `INSERT INTO org_bank_accounts
         (org_id, label, bank_code, bank_name, account_number, account_name, is_verified)
       VALUES ($1, 'Main', '058', 'GTBank', '0123456789', 'Sweep Test Church', TRUE)
       RETURNING id`,
      [orgId],
    );

    // The exact INSERT shape the sweep performs — this used to be
    // impossible when initiated_by was the literal string 'system'
    const payout = await queryOne<{ id: string; initiated_by: string }>(
      `INSERT INTO payout_requests
         (org_id, fund_type_id, bank_account_id, initiated_by,
          amount_kobo, purpose, status, expires_at)
       VALUES ($1, $2, $3, $4, 100000, 'Auto-sweep — FK test', 'PENDING',
               NOW() + INTERVAL '24 hours')
       RETURNING id, initiated_by`,
      [orgId, fund!.id, bank!.id, actorId],
    );

    expect(payout!.initiated_by).toBe(actorId);

    await query(`DELETE FROM payout_requests WHERE id = $1`, [payout!.id]);
  });
});
