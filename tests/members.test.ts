import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

const memberToken = makeMemberToken();

describe('GET /api/v1/me — member profile guard', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a garbage token', async () => {
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer not.a.jwt');

    expect(res.status).toBe(401);
  });

  it('rejects an ADMIN token — /me is member-only', async () => {
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', bearer(makeAdminToken('ADMIN')));

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/member/i);
  });
});

describe('GET /api/v1/me/funds — member fund list guard', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/me/funds');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/me/giving-history — query validation', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/me/giving-history');

    expect(res.status).toBe(401);
  });

  it('rejects a malformed period (must be YYYY-MM)', async () => {
    const res = await request(app)
      .get('/api/v1/me/giving-history?period=2026-6')
      .set('Authorization', bearer(memberToken));

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/YYYY-MM/i);
  });

  it('rejects a non-UUID fund_type_id filter', async () => {
    const res = await request(app)
      .get('/api/v1/me/giving-history?fund_type_id=tithe')
      .set('Authorization', bearer(memberToken));

    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/members — admin-only roster', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/members');

    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER token — roster is for admins', async () => {
    const res = await request(app)
      .get('/api/v1/members')
      .set('Authorization', bearer(memberToken));

    expect(res.status).toBe(403);
  });

  it('returns a list for an admin of a fresh org', async () => {
    const res = await request(app)
      .get('/api/v1/members')
      .set('Authorization', bearer(makeAdminToken('ADMIN')));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
