import { createHmac, createHash, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

/**
 * crypto.ts — HMAC verification, token hashing, and identity masking.
 *
 * Three jobs:
 *   1. Verify Nomba webhook signatures (HMAC-SHA256)
 *   2. Hash approval tokens before storing in DB (SHA-256)
 *   3. Mask phone numbers for approval page identity confirm
 */

// ── Nomba webhook HMAC verification ──────────────────────────────────────

/**
 * verifyNombaSignature — validates the nomba-signature header.
 *
 * Nomba signs a specific field concatenation (NOT the raw body) with
 * HMAC-SHA256, encoded as base64. The signing payload is:
 *   event_type:requestId:merchant.userId:merchant.walletId:
 *   transaction.transactionId:transaction.type:transaction.time:
 *   transaction.responseCode:nomba-timestamp
 *
 * @param rawBody   - raw Buffer from express.raw() (used to parse payload)
 * @param signature - value of the 'nomba-signature' header (base64)
 * @param timestamp - value of the 'nomba-timestamp' header
 * @returns true if signature matches, false otherwise
 */
export function verifyNombaSignature(
  rawBody: Buffer,
  signature: string,
  timestamp: string,
): boolean {
  if (!signature || !timestamp) return false;

  // Nomba signs the raw request body with HMAC-SHA256, base64-encoded
  const expected = createHmac('sha256', env.NOMBA_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');

  try {
    return timingSafeEqual(
      Buffer.from(expected,  'base64'),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

// ── Approval token hashing ────────────────────────────────────────────────

/**
 * hashToken — SHA-256 hashes an approval token for DB storage.
 *
 * The raw UUID token goes into the email link ONLY.
 * We store only the hash in payout_approvals.token_hash.
 * On approval, we hash the incoming token and compare to the stored hash.
 *
 * This way, even if the DB is compromised, tokens can't be replayed.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * verifyTokenHash — compares a raw token against a stored hash.
 * Returns true if they match.
 */
export function verifyTokenHash(rawToken: string, storedHash: string): boolean {
  const incoming = createHash('sha256').update(rawToken).digest('hex');
  try {
    return timingSafeEqual(
      Buffer.from(incoming, 'hex'),
      Buffer.from(storedHash, 'hex'),
    );
  } catch {
    return false;
  }
}

// ── Phone identity masking ────────────────────────────────────────────────

/**
 * maskPhone — returns the last 4 digits of a phone number.
 * Shown on the approval confirmation page:
 *   "Enter the last 4 digits of your registered phone: ____"
 *
 * Example: '+2348012345678' → '5678'
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4);
}

/**
 * verifyPhoneLast4 — checks if the provided 4 digits match the signatory's phone.
 * Used on the approval page to prevent link-forwarding attacks.
 *
 * @param input         - the 4 digits the signatory typed
 * @param signatoryPhone - the full phone stored in signatories table
 */
export function verifyPhoneLast4(input: string, signatoryPhone: string): boolean {
  if (!input || input.length !== 4 || !/^\d{4}$/.test(input)) return false;
  const last4 = maskPhone(signatoryPhone);
  return timingSafeEqual(
    Buffer.from(input),
    Buffer.from(last4),
  );
}

// ── Display masking ───────────────────────────────────────────────────────

/**
 * maskAccountNumber — shows only last 4 digits of a bank account.
 * Used in emails: "GTBank · Grace Bible Church · *6789"
 */
export function maskAccountNumber(accountNumber: string): string {
  return `*${accountNumber.slice(-4)}`;
}