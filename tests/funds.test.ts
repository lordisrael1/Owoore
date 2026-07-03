import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

const orgId      = randomUUID();
const adminToken = makeAdminToken('ADMIN', orgId);

describe('GET /api/v1/orgs/:orgId/funds — auth guard', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get(`/api/v1/orgs/${orgId}/funds`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed bearer token', async () => {
    const res = await request(app)
      .get(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', 'Bearer garbage.token.here');

    expect(res.status).toBe(401);
  });

  it('returns an empty list for a fresh org with an admin token', async () => {
    const res = await request(app)
      .get(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /api/v1/orgs/:orgId/funds — create validation + role guards', () => {
  it('rejects a member token (members cannot manage funds)', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(makeMemberToken(orgId)))
      .send({ name: 'Tithe' });

    expect(res.status).toBe(403);
  });

  it('rejects a TREASURER token (only ADMIN can create funds)', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(makeAdminToken('TREASURER', orgId)))
      .send({ name: 'Tithe' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a fund name shorter than 2 characters', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken))
      .send({ name: 'T' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a CAMPAIGN fund without an expires_at date', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken))
      .send({ name: 'Building Fund Drive', kind: 'CAMPAIGN' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/expires_at|CAMPAIGN/i);
  });

  it('rejects a negative expected amount', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken))
      .send({ name: 'Welfare', expected_amt: -500 });

    expect(res.status).toBe(422);
  });

  it('rejects an unknown fund kind', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/funds`)
      .set('Authorization', bearer(adminToken))
      .send({ name: 'Welfare', kind: 'ONE_OFF' });

    expect(res.status).toBe(422);
  });
});

describe('GET/PATCH/DELETE /api/v1/funds/:id — single fund', () => {
  it('rejects a non-UUID fund id', async () => {
    const res = await request(app)
      .get('/api/v1/funds/not-a-uuid')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(422);
  });

  it('returns 404 for a fund that does not exist', async () => {
    const res = await request(app)
      .get(`/api/v1/funds/${randomUUID()}`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('blocks a TREASURER from deleting a fund', async () => {
    const res = await request(app)
      .delete(`/api/v1/funds/${randomUUID()}`)
      .set('Authorization', bearer(makeAdminToken('TREASURER', orgId)));

    expect(res.status).toBe(403);
  });

  it('blocks a member from updating a fund', async () => {
    const res = await request(app)
      .patch(`/api/v1/funds/${randomUUID()}`)
      .set('Authorization', bearer(makeMemberToken(orgId)))
      .send({ name: 'Renamed' });

    expect(res.status).toBe(403);
  });
});
