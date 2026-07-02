/**
 * kobo.ts — internally, ALL amounts in this codebase are kobo (integer).
 *
 * ₦1.00 = 100 kobo. Never store or compute naira directly — always convert
 * at the boundary.
 *
 * These two functions are the single conversion point in the codebase.
 * Import them everywhere amounts are handled — never do * 100 inline.
 *
 * CAVEAT — Nomba is NOT consistent about units across its own API:
 *   - GET /v1/accounts/{id}/balance returns plain naira decimals (e.g. "360.0")
 *   - POST /v2/transfers/bank/{subAccountId} also expects naira in `amount`
 *     (confirmed live: sending a kobo integer here was read as 100x the
 *     intended naira value and rejected as INSUFFICIENT_BALANCE)
 *   Convert with fromKobo() immediately before building the request body
 *   for those endpoints. Don't assume kobo just because it's a Nomba call —
 *   verify per-endpoint before using amountKobo directly on the wire.
 */

/**
 * toKobo — converts naira (number) to kobo (integer).
 *
 * Examples:
 *   toKobo(50000)   → 5_000_000   (₦50,000)
 *   toKobo(1500)    → 150_000     (₦1,500)
 *   toKobo(0.50)    → 50          (50 kobo)
 *
 * Always returns an integer — rounds to nearest kobo.
 */
export function toKobo(naira: number): number {
  if (naira < 0) throw new Error(`toKobo: amount cannot be negative. Got ${naira}`);
  return Math.round(naira * 100);
}

/**
 * fromKobo — converts kobo (integer) to naira (decimal number).
 *
 * Examples:
 *   fromKobo(5_000_000)  → 50000    (₦50,000)
 *   fromKobo(150_000)    → 1500     (₦1,500)
 *   fromKobo(50)         → 0.50
 */
export function fromKobo(kobo: number): number {
  if (kobo < 0) throw new Error(`fromKobo: amount cannot be negative. Got ${kobo}`);
  return kobo / 100;
}

/**
 * assertKobo — throws if a value is clearly in naira when kobo is expected.
 * Use before any Nomba API call as a sanity check.
 *
 * Heuristic: if the value is < 100 it's almost certainly naira, not kobo.
 * (Minimum meaningful kobo amount for a church offering = ₦1 = 100 kobo)
 */
export function assertKobo(value: number, fieldName = 'amount'): void {
  if (value > 0 && value < 100) {
    throw new Error(
      `assertKobo: ${fieldName} looks like naira (${value}), not kobo. ` +
      `Use toKobo() before passing to Nomba. Expected ≥ 100 for any real transaction.`,
    );
  }
}

/**
 * safeKoboAdd — adds two kobo values safely.
 * Avoids floating-point drift that can happen with large sums.
 */
export function safeKoboAdd(a: number, b: number): number {
  return Math.round(a + b);
}

/**
 * safeKoboSubtract — subtracts b from a, returns 0 if result would be negative.
 * Used when computing available balance to prevent negative ledger values.
 */
export function safeKoboSubtract(a: number, b: number): number {
  return Math.max(0, Math.round(a - b));
}