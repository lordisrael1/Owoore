import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('GET /health', () => {
  it('returns 200 with status field', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('checks');
    expect(res.body.checks).toHaveProperty('database');
    expect(res.body.checks).toHaveProperty('nomba');
  });

  it('returns correct structure shape', async () => {
    const res = await request(app).get('/health');

    expect(res.body.status).toMatch(/^(ok|degraded|down)$/);
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.ts).toBeDefined();
    expect(res.body.checks.database.status).toMatch(/^(ok|fail)$/);
    expect(res.body.checks.nomba.status).toMatch(/^(ok|fail)$/);
  });
});

describe('404 handler', () => {
  it('returns 404 JSON for unknown top-level routes', async () => {
    const res = await request(app).get('/completely-unknown');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for wrong HTTP methods', async () => {
    const res = await request(app).delete('/health');

    expect(res.status).toBe(404);
  });
});
