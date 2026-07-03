import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { makeAdminToken, makeMemberToken, bearer } from './helpers';

const app = createApp();

const orgId      = randomUUID();
const adminToken = makeAdminToken('ADMIN', orgId);

describe('GET /api/v1/orgs/:orgId/reports/giving', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get(`/api/v1/orgs/${orgId}/reports/giving`);

    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER token', async () => {
    const res = await request(app)
      .get(`/api/v1/orgs/${orgId}/reports/giving`)
      .set('Authorization', bearer(makeMemberToken(orgId)));

    expect(res.status).toBe(403);
  });

  it('returns a JSON report for a fresh org', async () => {
    const res = await request(app)
      .get(`/api/v1/orgs/${orgId}/reports/giving`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('returns CSV with download headers when format=csv', async () => {
    const res = await request(app)
      .get(`/api/v1/orgs/${orgId}/reports/giving?format=csv`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.csv');
  });
});

describe('GET /api/v1/members/:id/statement', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get(`/api/v1/members/${randomUUID()}/statement`);

    expect(res.status).toBe(401);
  });

  it('returns 404 for a member that does not exist', async () => {
    const res = await request(app)
      .get(`/api/v1/members/${randomUUID()}/statement`)
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/v1/reports/arrears', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/reports/arrears');

    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER token', async () => {
    const res = await request(app)
      .get('/api/v1/reports/arrears')
      .set('Authorization', bearer(makeMemberToken(orgId)));

    expect(res.status).toBe(403);
  });

  it('returns an empty arrears list for a fresh org', async () => {
    const res = await request(app)
      .get('/api/v1/reports/arrears')
      .set('Authorization', bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});
