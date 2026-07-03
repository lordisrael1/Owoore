import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

const orgId      = randomUUID();
const adminToken = makeAdminToken('ADMIN', orgId);

const validBody = {
  fund_type_id:   randomUUID(),
  bank_code:      '058',
  account_number: '0123456789',
  amount:         50000,
  purpose:        'Roof contractor — Bello & Sons',
};

describe('POST /api/v1/payouts — role guards', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).post('/api/v1/payouts').send(validBody);

    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER token', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(makeMemberToken(orgId)))
      .send(validBody);

    expect(res.status).toBe(403);
  });

  it('rejects a SIGNATORY token — signatories approve, they do not initiate', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(makeAdminToken('SIGNATORY', orgId)))
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/v1/payouts — body validation', () => {
  it('rejects an empty body', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(adminToken))
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a zero amount', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(adminToken))
      .send({ ...validBody, amount: 0 });

    expect(res.status).toBe(422);
  });

  it('rejects an amount above the per-request ceiling', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(adminToken))
      .send({ ...validBody, amount: 200_000_000 });

    expect(res.status).toBe(422);
  });

  it('rejects an account number that is not 10 digits', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(adminToken))
      .send({ ...validBody, account_number: '12345' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/10-digit/i);
  });

  it('rejects a purpose shorter than 5 characters', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(adminToken))
      .send({ ...validBody, purpose: 'abc' });

    expect(res.status).toBe(422);
  });

  it('rejects a non-UUID fund_type_id', async () => {
    const res = await request(app)
      .post('/api/v1/payouts')
      .set('Authorization', bearer(adminToken))
      .send({ ...validBody, fund_type_id: 'tithe-fund' });

    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/payouts — list', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/payouts');

    expect(res.status).toBe(401);
  });

  it('returns an empty list for a fresh org', async () => {
    const res = await request(app)
      .get('/api/v1/payouts')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('allows a TREASURER to view the payout list', async () => {
    const res = await request(app)
      .get('/api/v1/payouts')
      .set('Authorization', bearer(makeAdminToken('TREASURER', orgId)));

    expect(res.status).toBe(200);
  });
});

describe('GET/DELETE /api/v1/payouts/:id', () => {
  it('returns 404 for a payout that does not exist', async () => {
    const res = await request(app)
      .get(`/api/v1/payouts/${randomUUID()}`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when cancelling a payout that does not exist', async () => {
    const res = await request(app)
      .delete(`/api/v1/payouts/${randomUUID()}`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(404);
  });

  it('blocks a SIGNATORY from cancelling a payout', async () => {
    const res = await request(app)
      .delete(`/api/v1/payouts/${randomUUID()}`)
      .set('Authorization', bearer(makeAdminToken('SIGNATORY', orgId)));

    expect(res.status).toBe(403);
  });
});
