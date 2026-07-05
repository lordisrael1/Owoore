import { logger } from './logger';

/**
 * circuit-breaker.ts — generic three-state circuit breaker.
 *
 * CLOSED    → normal operation. N consecutive failures trip it OPEN.
 * OPEN      → every call fails fast with CircuitOpenError (no network
 *             call, no 30s timeout burned). After a cooldown the next
 *             caller moves it to HALF_OPEN.
 * HALF_OPEN → a small number of probe requests are let through.
 *             Enough consecutive successes → CLOSED (cooldown resets).
 *             Any failure → back to OPEN with a DOUBLED cooldown,
 *             capped at maxCooldownMs — so a dead upstream is probed
 *             less and less aggressively, and a recovered one resumes
 *             traffic automatically.
 *
 * Deliberately transport-agnostic: it never decides WHAT counts as a
 * failure. The caller records recordFailure() only for systemic faults
 * (timeouts, connection errors, 5xx) — a 4xx "bad request" means the
 * upstream is alive and must be recorded as recordSuccess(), otherwise
 * a burst of validation errors would trip the breaker on a healthy API.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name:              string; // for logs: '[Breaker:{name}]'
  failureThreshold?: number; // consecutive failures to trip (default 5)
  successThreshold?: number; // half-open successes to close (default 2)
  baseCooldownMs?:   number; // first OPEN period (default 30s)
  maxCooldownMs?:    number; // cooldown backoff cap (default 5min)
  halfOpenMaxProbes?: number; // concurrent test requests allowed (default 2)
}

/** Thrown on fail-fast — callers map this to their own error type. */
export class CircuitOpenError extends Error {
  public readonly retryInMs: number;

  constructor(name: string, retryInMs: number) {
    super(`Circuit '${name}' is open — failing fast (retry in ~${Math.ceil(retryInMs / 1000)}s)`);
    this.retryInMs = retryInMs;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

export class CircuitBreaker {
  private readonly name:              string;
  private readonly failureThreshold:  number;
  private readonly successThreshold:  number;
  private readonly baseCooldownMs:    number;
  private readonly maxCooldownMs:     number;
  private readonly halfOpenMaxProbes: number;

  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private cooldownMs:  number;
  private nextProbeAt = 0; // unix ms — when OPEN may transition to HALF_OPEN
  private halfOpenSuccesses = 0;
  private halfOpenInFlight  = 0;

  constructor(opts: CircuitBreakerOptions) {
    this.name              = opts.name;
    this.failureThreshold  = opts.failureThreshold  ?? 5;
    this.successThreshold  = opts.successThreshold  ?? 2;
    this.baseCooldownMs    = opts.baseCooldownMs    ?? 30_000;
    this.maxCooldownMs     = opts.maxCooldownMs     ?? 300_000;
    this.halfOpenMaxProbes = opts.halfOpenMaxProbes ?? 2;
    this.cooldownMs        = this.baseCooldownMs;
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * assertRequestAllowed — call BEFORE making the guarded request.
   * Throws CircuitOpenError when the request must fail fast.
   * When OPEN and the cooldown has elapsed, flips to HALF_OPEN and
   * admits the caller as a probe.
   */
  assertRequestAllowed(): void {
    if (this.state === 'CLOSED') return;

    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now < this.nextProbeAt) {
        throw new CircuitOpenError(this.name, this.nextProbeAt - now);
      }
      // Cooldown elapsed — this request becomes the first probe.
      this.state = 'HALF_OPEN';
      this.halfOpenSuccesses = 0;
      this.halfOpenInFlight  = 0;
      logger.warn(`[Breaker:${this.name}] HALF_OPEN — letting probe requests through`);
    }

    // HALF_OPEN: admit only a bounded number of concurrent probes so a
    // thundering herd can't hammer a barely-recovering upstream.
    if (this.halfOpenInFlight >= this.halfOpenMaxProbes) {
      throw new CircuitOpenError(this.name, this.cooldownMs);
    }
    this.halfOpenInFlight++;
  }

  /** recordSuccess — the guarded request completed and the upstream is alive. */
  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.state = 'CLOSED';
        this.consecutiveFailures = 0;
        this.cooldownMs = this.baseCooldownMs; // recovery resets the backoff
        logger.info(`[Breaker:${this.name}] CLOSED — upstream recovered, traffic resumed`);
      }
      return;
    }

    // CLOSED: any success breaks a failure streak. (A late success from a
    // request that was in flight when the breaker tripped OPEN is ignored —
    // only a half-open probe may close the circuit.)
    if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  /** recordFailure — the guarded request failed SYSTEMICALLY (timeout/5xx/conn). */
  recordFailure(): void {
    if (this.state === 'HALF_OPEN') {
      // Probe failed — reopen and wait LONGER before the next probe.
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.trip();
      return;
    }

    if (this.state === 'CLOSED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.cooldownMs = this.baseCooldownMs;
        this.trip();
      }
    }
    // OPEN: late failure from a pre-trip in-flight request — nothing to do.
  }

  private trip(): void {
    this.state = 'OPEN';
    this.nextProbeAt = Date.now() + this.cooldownMs;
    logger.error(
      `[Breaker:${this.name}] OPEN — failing fast for ${Math.round(this.cooldownMs / 1000)}s ` +
      `(${this.consecutiveFailures} consecutive failures)`,
    );
  }
}
