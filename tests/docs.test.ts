import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('GET /docs — API reference', () => {
  it('serves the Scalar viewer page without auth', async () => {
    const res = await request(app).get('/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('/docs/openapi.yaml');
  });

  it('serves the hero graphic as SVG', async () => {
    const res = await request(app).get('/docs/owoore-hero.svg');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
    // supertest treats image/* content-types as binary — body lands in
    // res.body (a Buffer), not res.text, unlike the text/yaml route above.
    const body = Buffer.isBuffer(res.body) ? res.body.toString('utf-8') : res.text;
    expect(body).toContain('<svg');
    expect(body).toContain('Register Church');
  });

  it('serves the OpenAPI spec as YAML, embedding the hero graphic in the intro', async () => {
    const res = await request(app).get('/docs/openapi.yaml');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    expect(res.text).toContain('openapi: 3.1.0');
    // The money contract is the point of these docs — keep it stated
    expect(res.text).toContain('KOBO');
    expect(res.text).toContain('/api/v1/webhooks/nomba');
    // The hero graphic is embedded via markdown in info.description so
    // Scalar lays it out inline in its own compact intro section, rather
    // than as a separate oversized block pushing the sidebar off-screen.
    expect(res.text).toContain('/docs/owoore-hero.svg');
  });
});
