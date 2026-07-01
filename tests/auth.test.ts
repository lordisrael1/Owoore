import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('POST /api/v1/auth/send-otp', () => {
  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/send-otp')
      .send({ org_slug: 'test-church' });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects missing org_slug', async () => {
    const res = await request(app)
      .post('/api/v1/auth/send-otp')
      .send({ email: 'member@example.com' });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects invalid email format', async () => {
    const res = await request(app)
      .post('/api/v1/auth/send-otp')
      .send({ email: 'not-an-email', org_slug: 'test-church' });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/auth/verify-otp', () => {
  it('rejects missing fields', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify-otp')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects invalid OTP format (not 6 digits)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify-otp')
      .send({
        email: 'member@example.com',
        code: 'abc',
        org_slug: 'test-church',
        name: 'Test Member',
      });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects non-numeric OTP', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify-otp')
      .send({
        email: 'member@example.com',
        code: 'abcdef',
        org_slug: 'test-church',
        name: 'Test Member',
      });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/auth/admin/login', () => {
  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .send({ password: 'testpassword' });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects missing password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .send({ email: 'admin@test.com' });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rejects request without Bearer token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh');

    expect(res.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Authorization', 'Bearer invalidtoken123');

    expect(res.status).toBe(401);
  });
});
