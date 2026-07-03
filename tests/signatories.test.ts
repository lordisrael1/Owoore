import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

const orgId      = randomUUID();
const adminToken = makeAdminToken('ADMIN', orgId);

describe('GET /api/v1/signatories — auth guards', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/signatories');

    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER token', async () => {
    const res = await request(app)
      .get('/api/v1/signatories')
      .set('Authorization', bearer(makeMemberToken(orgId)));

    expect(res.status).toBe(403);
  });

  it('returns an empty list for a fresh org', async () => {
    const res = await request(app)
      .get('/api/v1/signatories')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});

describe('signatory writes — ADMIN only', () => {
  it('blocks a TREASURER from adding a signatory', async () => {
    const res = await request(app)
      .post('/api/v1/signatories')
      .set('Authorization', bearer(makeAdminToken('TREASURER', orgId)))
      .send({ name: 'Elder Musa', email: 'musa@test.local', role: 'ELDER' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('blocks a SIGNATORY from adding a signatory', async () => {
    const res = await request(app)
      .post('/api/v1/signatories')
      .set('Authorization', bearer(makeAdminToken('SIGNATORY', orgId)))
      .send({ name: 'Elder Musa', email: 'musa@test.local', role: 'ELDER' });

    expect(res.status).toBe(403);
  });

  it('blocks a TREASURER from updating a signatory', async () => {
    const res = await request(app)
      .patch(`/api/v1/signatories/${randomUUID()}`)
      .set('Authorization', bearer(makeAdminToken('TREASURER', orgId)))
      .send({ can_approve: false });

    expect(res.status).toBe(403);
  });

  it('returns 404 when updating a signatory that does not exist', async () => {
    const res = await request(app)
      .patch(`/api/v1/signatories/${randomUUID()}`)
      .set('Authorization', bearer(adminToken))
      .send({ can_approve: false });

    expect(res.status).toBe(404);
  });

  it('returns 404 when deactivating a signatory that does not exist', async () => {
    const res = await request(app)
      .delete(`/api/v1/signatories/${randomUUID()}`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(404);
  });
});

describe('payout policy — /api/v1/signatories/policy', () => {
  it('rejects reads without a token', async () => {
    const res = await request(app).get('/api/v1/signatories/policy');

    expect(res.status).toBe(401);
  });

  it('blocks a TREASURER from changing the policy', async () => {
    const res = await request(app)
      .patch('/api/v1/signatories/policy')
      .set('Authorization', bearer(makeAdminToken('TREASURER', orgId)))
      .send({ min_approvers: 1 });

    expect(res.status).toBe(403);
  });

  it('blocks a MEMBER from reading the policy', async () => {
    const res = await request(app)
      .get('/api/v1/signatories/policy')
      .set('Authorization', bearer(makeMemberToken(orgId)));

    expect(res.status).toBe(403);
  });
});
