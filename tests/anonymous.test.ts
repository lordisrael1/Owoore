import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('GET /api/v1/give/:orgSlug — public giving page', () => {
  it('returns 404 for a slug that does not exist', async () => {
    const res = await request(app).get('/api/v1/give/no-such-church-slug-000');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('includes the bad slug in the error message so the giver can spot typos', async () => {
    const res = await request(app).get('/api/v1/give/grase-bible-church');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('grase-bible-church');
  });

  it('requires no Authorization header (public route — 404 not 401)', async () => {
    const res = await request(app).get('/api/v1/give/some-church');

    // A protected route would 401 without a token; this one resolves the slug
    expect(res.status).not.toBe(401);
  });

  it('returns 404 for the bare /give path (no slug)', async () => {
    const res = await request(app).get('/api/v1/give');

    expect(res.status).toBe(404);
  });
});
