import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

const orgId      = randomUUID();
const adminToken = makeAdminToken('ADMIN', orgId);

const ENDPOINTS = [
  '/api/v1/dashboard/summary',
  '/api/v1/dashboard/fund-breakdown',
  '/api/v1/dashboard/member-status',
  '/api/v1/dashboard/payout-history',
  '/api/v1/dashboard/activity',
];

describe('dashboard auth guards', () => {
  for (const path of ENDPOINTS) {
    it(`${path} rejects requests without a token`, async () => {
      const res = await request(app).get(path);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it(`${path} rejects a MEMBER token`, async () => {
      const res = await request(app)
        .get(path)
        .set('Authorization', bearer(makeMemberToken(orgId)));

      expect(res.status).toBe(403);
    });
  }
});

describe('GET /api/v1/dashboard/summary — shape', () => {
  it('returns zeroed metrics with display values for a fresh org', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data).toHaveProperty('total_collected_all_time_kobo');
    expect(data).toHaveProperty('available_balance_kobo');
    expect(data).toHaveProperty('pending_payouts_kobo');
    expect(data).toHaveProperty('active_members');
    expect(data).toHaveProperty('period_month');
    expect(data).toHaveProperty('total_collected_display');
    expect(data).toHaveProperty('available_display');
    expect(Array.isArray(data.trend)).toBe(true);

    // Fresh org — every counter must be zero
    expect(data.total_collected_all_time_kobo).toBe(0);
    expect(data.available_balance_kobo).toBe(0);
    expect(data.active_members).toBe(0);
    expect(data.period_month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('remaining dashboard panels — shape', () => {
  it('fund-breakdown returns an array', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/fund-breakdown')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('member-status returns an array', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/member-status')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('payout-history returns an array', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/payout-history')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('activity returns an empty array for a fresh org', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/activity')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('activity caps the limit query at 50', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/activity?limit=99999')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/v1/dashboard/transactions — giving ledger', () => {
  const path = '/api/v1/dashboard/transactions';

  it('rejects requests without a token', async () => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER token', async () => {
    const res = await request(app)
      .get(path)
      .set('Authorization', bearer(makeMemberToken(orgId)));
    expect(res.status).toBe(403);
  });

  it('returns an empty paginated ledger for a fresh org', async () => {
    const res = await request(app)
      .get(path)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.transactions).toEqual([]);
    expect(res.body.data.limit).toBe(25);
    expect(res.body.data.offset).toBe(0);
  });

  it('accepts fund and period filters and clamps the limit', async () => {
    const res = await request(app)
      .get(`${path}?fund_type_id=${randomUUID()}&period=2026-07&limit=9999`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(100); // clamped to max
  });

  it('400s on a malformed fund_type_id instead of leaking a DB error', async () => {
    const res = await request(app)
      .get(`${path}?fund_type_id=not-a-uuid`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(400);
  });

  it('400s on a malformed period', async () => {
    const res = await request(app)
      .get(`${path}?period=July2026`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(400);
  });
});
