import { randomUUID, createHash } from 'crypto';

/**
 * generateReference.ts — consistent reference/key generation across the app.
 *
 * Nomba API rule: every external write must be keyed on a unique merchantTxRef.
 * Reusing the same ref on a retry tells Nomba "same attempt, not a new one" — idempotency.
 *
 * ALL references that touch Nomba must be generated here — nowhere else.
 */

/**
 * vaReference — the accountRef passed to Nomba when creating a per-member VA.
 * Format: m_{30-char hex hash} — 32 chars total, within Nomba's 16–64 limit.
 *
 * Deterministic from (memberId, fundTypeId) so retries produce the same ref.
 * Stored in member_fund_accounts.account_reference as the webhook lookup key.
 */
export function vaReference(memberId: string, fundTypeId: string): string {
  return 'm_' + createHash('sha256').update(`${memberId}:${fundTypeId}`).digest('hex').slice(0, 30);
}

/**
 * sharedVaReference — accountRef for org-level shared VAs (Offering, Anonymous Giving, etc.)
 * Format: s_{30-char hex hash} — 32 chars total, within Nomba's 16–64 limit.
 *
 * Deterministic from (orgId, fundTypeId). Stored in org_shared_fund_accounts.
 */
export function sharedVaReference(orgId: string, fundTypeId: string): string {
  return 's_' + createHash('sha256').update(`${orgId}:${fundTypeId}`).digest('hex').slice(0, 30);
}


/**
 * payoutTransferRef — merchantTxRef for a Nomba bank transfer.
 * Format: payout_{payout_request_id}
 *
 * Using the payout_request_id means retrying a FAILED payout
 * uses the exact same ref — Nomba deduplicates it automatically.
 * This prevents double-transfer on network errors.
 */
export function payoutTransferRef(payoutRequestId: string): string {
  return `payout_${payoutRequestId}`;
}

/**
 * sweepTransferRef — merchantTxRef for an auto-sweep transfer.
 * Format: sweep_{fund_type_id}_{YYYY-MM-DD}
 *
 * Date-scoped so daily sweeps of the same fund get unique refs.
 */
export function sweepTransferRef(fundTypeId: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `sweep_${fundTypeId}_${date}`;
}

/**
 * approvalToken — UUID token sent in approval email links.
 * Single-use. Stored as SHA-256 hash in DB; raw value only in the email.
 */
export function approvalToken(): string {
  return randomUUID();
}

/**
 * memberCode — human-readable member ID shown on admin dashboard.
 * Format: CHR-{5 digit zero-padded number}
 * The number is based on count of existing members in the org.
 *
 * Example: CHR-00142
 */
export function memberCode(memberCount: number): string {
  return `CHR-${String(memberCount + 1).padStart(5, '0')}`;
}

