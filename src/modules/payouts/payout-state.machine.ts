/**
 * payout-state-machine.ts
 *
 * Enforces valid state transitions for payout_requests.
 * Any code that changes payout status MUST call assertTransition first.
 *
 * Valid transitions:
 *   PENDING      → PARTIAL      (first approval received)
 *   PENDING      → APPROVED     (quorum reached on first approval — small orgs)
 *   PENDING      → DECLINED     (any signatory declines)
 *   PENDING      → EXPIRED      (72h cron fires, no quorum)
 *   PENDING      → CANCELLED    (initiator cancels before any approval)
 *   PARTIAL      → APPROVED     (quorum reached)
 *   PARTIAL      → DECLINED     (any signatory declines)
 *   PARTIAL      → EXPIRED      (72h cron fires)
 *   APPROVED     → TRANSFERRING (Nomba API called)
 *   TRANSFERRING → TRANSFERRED  (transfer.success webhook)
 *   TRANSFERRING → FAILED       (transfer.failed webhook)
 *   FAILED       → PENDING      (admin retries — reuses same nomba_transfer_ref)
 */

export type PayoutStatus =
  | 'PENDING'
  | 'PARTIAL'
  | 'APPROVED'
  | 'TRANSFERRING'
  | 'TRANSFERRED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED';

// Terminal states — once reached, no further transitions allowed
export const TERMINAL_STATES: PayoutStatus[] = [
  'TRANSFERRED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
];

const VALID_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  PENDING:      ['PARTIAL', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
  PARTIAL:      ['APPROVED', 'DECLINED', 'EXPIRED'],
  APPROVED:     ['TRANSFERRING'],
  TRANSFERRING: ['TRANSFERRED', 'FAILED'],
  TRANSFERRED:  [],   // terminal
  DECLINED:     [],   // terminal
  EXPIRED:      [],   // terminal
  CANCELLED:    [],   // terminal
  FAILED:       ['PENDING'],  // admin retry resets to PENDING
};

import { AppError } from '../../utils/AppError';

/**
 * assertTransition — throws if the from→to transition is not valid.
 * Call before every status update on payout_requests.
 */
export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  const allowed = VALID_TRANSITIONS[from] ?? [];

  if (!allowed.includes(to)) {
    throw new AppError(
      `Invalid payout state transition: ${from} → ${to}. ` +
      `Allowed from ${from}: [${allowed.join(', ') || 'none — terminal state'}]`,
      409,
      true,
      'INVALID_STATE_TRANSITION',
    );
  }
}

/**
 * isTerminal — returns true if the status is a terminal state.
 * Terminal states cannot be transitioned from.
 */
export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * canCancel — initiator can only cancel if no approvals have been recorded yet.
 */
export function canCancel(status: PayoutStatus): boolean {
  return status === 'PENDING';
}