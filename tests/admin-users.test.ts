import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

const orgId      = randomUUID();
const adminToken = makeAdminToken('ADMIN', orgId);

describe('POST /api/v1/admin-users/invite — role guards', () => {
  const body = { email: 'newtreasurer@test.local', name: 'New Treasurer' };

  it('rejects requests without a token', async () => {
    const res = await request(app).post('/api/v1/admin-users/invite').send(body);

    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER token', async () => {
    const res = await request(app)
      .post('/api/v1/admin-users/invite')
      .set('Authorization', bearer(makeMemberToken(orgId)))
      .send(body);

    expect(res.status).toBe(403);
  });

  it('rejects a TREASURER token — only ADMINs can invite', async () => {
    const res = await request(app)
      .post('/api/v1/admin-users/invite')
      .set('Authorization', bearer(makeAdminToken('TREASURER', orgId)))
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/v1/admin-users/invite — body validation', () => {
  it('rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/v1/admin-users/invite')
      .set('Authorization', bearer(adminToken))
      .send({ email: 'nope', name: 'New Treasurer' });

    expect(res.status).toBe(422);
  });

  it('rejects a missing name', async () => {
    const res = await request(app)
      .post('/api/v1/admin-users/invite')
      .set('Authorization', bearer(adminToken))
      .send({ email: 'treasurer@test.local' });

    expect(res.status).toBe(422);
  });

  it('rejects a role outside TREASURER/ADMIN', async () => {
    const res = await request(app)
      .post('/api/v1/admin-users/invite')
      .set('Authorization', bearer(adminToken))
      .send({ email: 'treasurer@test.local', name: 'New Treasurer', role: 'PASTOR' });

    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/admin-users/invite/:token — invite details', () => {
  it('rejects a non-UUID token', async () => {
    const res = await request(app).get('/api/v1/admin-users/invite/not-a-uuid');

    expect(res.status).toBe(422);
  });

  it('fails cleanly for an invite token that does not exist', async () => {
    const res = await request(app).get(`/api/v1/admin-users/invite/${randomUUID()}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/admin-users/invite/:token — accept + set password', () => {
  it('rejects a password shorter than 8 characters before touching the DB', async () => {
    const res = await request(app)
      .post(`/api/v1/admin-users/invite/${randomUUID()}`)
      .send({ password: 'short' });

    expect(res.status).toBe(422);
  });

  it('fails cleanly for an invite token that does not exist', async () => {
    const res = await request(app)
      .post(`/api/v1/admin-users/invite/${randomUUID()}`)
      .send({ password: 'longenoughpassword' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
  });

  it('legacy accept-invite rejects a non-UUID token in the body', async () => {
    const res = await request(app)
      .post('/api/v1/admin-users/accept-invite')
      .send({ token: 'nope', password: 'longenoughpassword' });

    expect(res.status).toBe(422);
  });
});
