import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, bearer } from './helpers';

const app = createApp();

describe('POST /api/v1/orgs — registration validation', () => {
  it('rejects an empty body', async () => {
    const res = await request(app).post('/api/v1/orgs').send({});

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a church name shorter than 3 characters', async () => {
    const res = await request(app).post('/api/v1/orgs').send({
      name:           'ab',
      admin_name:     'Pastor John',
      admin_email:    'pastor@church.org',
      admin_password: 'supersecret',
    });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects an invalid admin email', async () => {
    const res = await request(app).post('/api/v1/orgs').send({
      name:           'Grace Bible Church',
      admin_name:     'Pastor John',
      admin_email:    'not-an-email',
      admin_password: 'supersecret',
    });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app).post('/api/v1/orgs').send({
      name:           'Grace Bible Church',
      admin_name:     'Pastor John',
      admin_email:    'pastor@church.org',
      admin_password: 'short',
    });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects a missing admin_name', async () => {
    const res = await request(app).post('/api/v1/orgs').send({
      name:           'Grace Bible Church',
      admin_email:    'pastor@church.org',
      admin_password: 'supersecret',
    });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/orgs/:slug — public lookup', () => {
  it('returns 404 for a slug that does not exist', async () => {
    const res = await request(app).get('/api/v1/orgs/no-such-church-xyz-000');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/v1/orgs/:id — admin auth required', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app)
      .patch(`/api/v1/orgs/${randomUUID()}`)
      .send({ name: 'New Church Name' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a non-UUID org id', async () => {
    const res = await request(app)
      .patch('/api/v1/orgs/not-a-uuid')
      .set('Authorization', bearer(makeAdminToken('ADMIN')))
      .send({ name: 'New Church Name' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("blocks an admin from updating a DIFFERENT org (tenant isolation)", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();

    const res = await request(app)
      .patch(`/api/v1/orgs/${orgB}`)
      .set('Authorization', bearer(makeAdminToken('ADMIN', orgA)))
      .send({ name: 'Hostile Takeover Church' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
