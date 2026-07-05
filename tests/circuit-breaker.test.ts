import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/utils/circuit-breaker';

/**
 * circuit-breaker.test.ts — full state-machine cycle:
 *
 *   CLOSED --(5 consecutive failures)--> OPEN
 *   OPEN   --(cooldown elapses)--------> HALF_OPEN
 *   HALF_OPEN --(2 probe successes)----> CLOSED
 *   HALF_OPEN --(probe failure)--------> OPEN with DOUBLED cooldown
 */

const OPTS = {
  name:              'test',
  failureThreshold:  5,
  successThreshold:  2,
  baseCooldownMs:    30_000,
  maxCooldownMs:     300_000,
  halfOpenMaxProbes: 2,
};

function tripBreaker(breaker: CircuitBreaker): void {
  for (let i = 0; i < OPTS.failureThreshold; i++) {
    breaker.assertRequestAllowed();
    breaker.recordFailure();
  }
}

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker(OPTS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts CLOSED and lets requests through', () => {
    expect(breaker.getState()).toBe('CLOSED');
    expect(() => breaker.assertRequestAllowed()).not.toThrow();
  });

  it('a success resets the consecutive-failure streak', () => {
    for (let i = 0; i < OPTS.failureThreshold - 1; i++) breaker.recordFailure();
    breaker.recordSuccess(); // streak broken
    for (let i = 0; i < OPTS.failureThreshold - 1; i++) breaker.recordFailure();

    expect(breaker.getState()).toBe('CLOSED'); // never reached 5 in a row
  });

  it('trips OPEN after the failure threshold and fails fast', () => {
    tripBreaker(breaker);

    expect(breaker.getState()).toBe('OPEN');
    expect(() => breaker.assertRequestAllowed()).toThrow(CircuitOpenError);
  });

  it('CircuitOpenError carries the remaining cooldown', () => {
    tripBreaker(breaker);
    vi.advanceTimersByTime(10_000);

    try {
      breaker.assertRequestAllowed();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryInMs).toBe(20_000);
    }
  });

  it('moves to HALF_OPEN after the cooldown and closes on enough probe successes', () => {
    tripBreaker(breaker);
    vi.advanceTimersByTime(OPTS.baseCooldownMs);

    // First probe admitted — state flips to HALF_OPEN
    expect(() => breaker.assertRequestAllowed()).not.toThrow();
    expect(breaker.getState()).toBe('HALF_OPEN');
    breaker.recordSuccess();

    // Second probe success reaches successThreshold → CLOSED
    breaker.assertRequestAllowed();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('caps concurrent half-open probes', () => {
    tripBreaker(breaker);
    vi.advanceTimersByTime(OPTS.baseCooldownMs);

    breaker.assertRequestAllowed(); // probe 1 (in flight)
    breaker.assertRequestAllowed(); // probe 2 (in flight)
    expect(() => breaker.assertRequestAllowed()).toThrow(CircuitOpenError);
  });

  it('a failed probe re-opens with a doubled cooldown', () => {
    tripBreaker(breaker);
    vi.advanceTimersByTime(OPTS.baseCooldownMs);

    breaker.assertRequestAllowed();
    breaker.recordFailure(); // probe fails → OPEN, cooldown now 60s
    expect(breaker.getState()).toBe('OPEN');

    // 30s (the old cooldown) is no longer enough
    vi.advanceTimersByTime(30_000);
    expect(() => breaker.assertRequestAllowed()).toThrow(CircuitOpenError);

    // ...but 60s total is
    vi.advanceTimersByTime(30_000);
    expect(() => breaker.assertRequestAllowed()).not.toThrow();
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('cooldown backoff is capped at maxCooldownMs', () => {
    tripBreaker(breaker);

    // Fail 10 probes in a row — cooldown would be 30s * 2^10 without a cap
    let cooldown = OPTS.baseCooldownMs;
    for (let i = 0; i < 10; i++) {
      cooldown = Math.min(cooldown * 2, OPTS.maxCooldownMs);
      vi.advanceTimersByTime(600_000); // way past any cooldown
      breaker.assertRequestAllowed();
      breaker.recordFailure();
    }

    vi.advanceTimersByTime(OPTS.maxCooldownMs - 1);
    expect(() => breaker.assertRequestAllowed()).toThrow(CircuitOpenError);
    vi.advanceTimersByTime(1);
    expect(() => breaker.assertRequestAllowed()).not.toThrow();
  });

  it('recovery resets the cooldown backoff to base', () => {
    tripBreaker(breaker);

    // One failed probe → cooldown doubled to 60s
    vi.advanceTimersByTime(OPTS.baseCooldownMs);
    breaker.assertRequestAllowed();
    breaker.recordFailure();

    // Recover fully
    vi.advanceTimersByTime(60_000);
    breaker.assertRequestAllowed();
    breaker.recordSuccess();
    breaker.assertRequestAllowed();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');

    // Trip again — the FIRST cooldown must be back to 30s, not 60s
    tripBreaker(breaker);
    vi.advanceTimersByTime(OPTS.baseCooldownMs);
    expect(() => breaker.assertRequestAllowed()).not.toThrow();
  });

  it('a late success from a pre-trip request cannot close an OPEN circuit', () => {
    tripBreaker(breaker);
    breaker.recordSuccess(); // in-flight request from before the trip resolves late

    expect(breaker.getState()).toBe('OPEN');
    expect(() => breaker.assertRequestAllowed()).toThrow(CircuitOpenError);
  });
});
