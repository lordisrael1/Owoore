import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

describe('POST /api/v1/me/funds/:fundId/account — VA provisioning guard', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).post(`/api/v1/me/funds/${randomUUID()}/account`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an ADMIN token — VAs belong to members', async () => {
    const res = await request(app)
      .post(`/api/v1/me/funds/${randomUUID()}/account`)
      .set('Authorization', bearer(makeAdminToken('ADMIN')));

    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/me/accounts — member VA list', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/me/accounts');

    expect(res.status).toBe(401);
  });

  it('rejects an ADMIN token', async () => {
    const res = await request(app)
      .get('/api/v1/me/accounts')
      .set('Authorization', bearer(makeAdminToken('TREASURER')));

    expect(res.status).toBe(403);
  });
});

describe('rate limiting on VA routes', () => {
  it('exposes standard RateLimit headers on authenticated requests', async () => {
    const res = await request(app)
      .get('/api/v1/me/accounts')
      .set('Authorization', bearer(makeMemberToken()));

    // generalRateLimiter uses standardHeaders — the response must carry
    // the RateLimit headers regardless of the handler outcome
    const hasRateLimitHeaders =
      res.headers['ratelimit-limit'] !== undefined ||
      res.headers['ratelimit'] !== undefined ||
      res.headers['ratelimit-policy'] !== undefined;

    expect(hasRateLimitHeaders).toBe(true);
    expect(res.status).toBeLessThan(500);
  });
});
