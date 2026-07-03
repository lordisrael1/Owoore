import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { makeAdminToken, bearer } from './helpers';
import {
  assertTransition,
  isTerminal,
  TERMINAL_STATES,
  type PayoutStatus,
} from '../src/modules/payouts/payout-state.machine';
import {
  hashToken,
  verifyTokenHash,
  verifyPhoneLast4,
  maskPhone,
  maskAccountNumber,
} from '../src/utils/crypto';

/**
 * security.test.ts — the cross-cutting suite.
 *
 * The module tests check that each door is locked; this file checks the
 * locks themselves: multi-tenant isolation, JWT forgery/expiry, the payout
 * state machine's terminal guarantees, and the token-hashing primitives
 * that the whole approval flow depends on.
 */

const app = createApp();

describe('multi-tenant isolation', () => {
  it('an admin of church A cannot modify church B', async () => {
    const churchA = randomUUID();
    const churchB = randomUUID();

    const res = await request(app)
      .patch(`/api/v1/orgs/${churchB}`)
      .set('Authorization', bearer(makeAdminToken('ADMIN', churchA)))
      .send({ name: 'Takeover Attempt' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('JWT hardening', () => {
  const payload = {
    sub: randomUUID(), orgId: randomUUID(),
    email: 'forger@evil.local', role: 'MEMBER',
  };

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign(payload, 'not-the-real-secret-not-the-real-secret');

    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/invalid token/i);
  });

  it('rejects an expired token with a session-expired message', async () => {
    const expired = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '-10s' });

    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('a SIGNATORY token cannot escalate to ADMIN-only actions', async () => {
    const res = await request(app)
      .post(`/api/v1/orgs/${randomUUID()}/funds`)
      .set('Authorization', bearer(makeAdminToken('SIGNATORY')))
      .send({ name: 'Slush Fund' });

    expect(res.status).toBe(403);
  });
});

describe('payout state machine — terminal states are truly terminal', () => {
  const ALL_STATES: PayoutStatus[] = [
    'PENDING', 'PARTIAL', 'APPROVED', 'TRANSFERRING',
    'TRANSFERRED', 'DECLINED', 'EXPIRED', 'FAILED', 'CANCELLED',
  ];

  it('no terminal state can transition anywhere — money moved is money moved', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(isTerminal(terminal)).toBe(true);
      for (const target of ALL_STATES) {
        expect(() => assertTransition(terminal, target)).toThrowError(/Invalid payout state transition/);
      }
    }
  });

  it('a payout cannot skip approval and jump straight to TRANSFERRED', () => {
    expect(() => assertTransition('PENDING', 'TRANSFERRED')).toThrow();
    expect(() => assertTransition('PENDING', 'TRANSFERRING')).toThrow();
    expect(() => assertTransition('PARTIAL', 'TRANSFERRED')).toThrow();
  });

  it('allows the documented happy path and the FAILED retry loop', () => {
    expect(() => assertTransition('PENDING', 'PARTIAL')).not.toThrow();
    expect(() => assertTransition('PARTIAL', 'APPROVED')).not.toThrow();
    expect(() => assertTransition('APPROVED', 'TRANSFERRING')).not.toThrow();
    expect(() => assertTransition('TRANSFERRING', 'TRANSFERRED')).not.toThrow();
    expect(() => assertTransition('TRANSFERRING', 'FAILED')).not.toThrow();
    expect(() => assertTransition('FAILED', 'PENDING')).not.toThrow(); // idempotent retry
  });
});

describe('token hashing primitives', () => {
  it('hashToken is a deterministic SHA-256 hex digest', () => {
    const token = randomUUID();
    const hash  = hashToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);       // deterministic
    expect(hashToken(randomUUID())).not.toBe(hash);
  });

  it('verifyTokenHash accepts the right token and rejects the wrong one', () => {
    const token = randomUUID();
    const hash  = hashToken(token);

    expect(verifyTokenHash(token, hash)).toBe(true);
    expect(verifyTokenHash(randomUUID(), hash)).toBe(false);
    expect(verifyTokenHash('', hash)).toBe(false);
  });

  it('verifyPhoneLast4 enforces exactly 4 digits and correct match', () => {
    const phone = '+2348012345678';

    expect(maskPhone(phone)).toBe('5678');
    expect(verifyPhoneLast4('5678', phone)).toBe(true);
    expect(verifyPhoneLast4('0000', phone)).toBe(false);
    expect(verifyPhoneLast4('567', phone)).toBe(false);   // too short
    expect(verifyPhoneLast4('56789', phone)).toBe(false); // too long
    expect(verifyPhoneLast4('abcd', phone)).toBe(false);  // non-numeric
    expect(verifyPhoneLast4('', phone)).toBe(false);
  });

  it('maskAccountNumber never leaks more than the last 4 digits', () => {
    expect(maskAccountNumber('0123456789')).toBe('*6789');
  });
});

describe('error envelope consistency', () => {
  it('unknown API routes return the standard error shape', async () => {
    const res = await request(app).get('/api/v1/definitely-not-a-route');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  it('production-style errors never leak stack traces in the envelope', async () => {
    const res = await request(app).get('/api/v1/orgs/no-such-slug-xyz');

    expect(res.body.error).toBeDefined();
    expect(res.body.error.stack).toBeUndefined();
  });
});
