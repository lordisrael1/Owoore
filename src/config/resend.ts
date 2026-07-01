import { Resend } from 'resend';
import { env } from './env';

// ── Resend client ──────────────────────────────────────────────────────────
export const resend = new Resend(env.RESEND_API_KEY);

/**
 * FROM_ADDRESS — used as the sender on all transactional emails.
 * Format: "Owoore <noreply@owoore.ng>"
 * Set RESEND_FROM_ADDRESS and RESEND_FROM_NAME in your .env to override.
 */
export const FROM_ADDRESS = `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_ADDRESS}>`;

/**
 * EMAIL_SUBJECTS — centralised subject lines so they stay consistent
 * across all templates and are easy to A/B test later.
 */
export const EMAIL_SUBJECTS = {
  OTP: 'Your Owoore verification code',
  WELCOME: 'Welcome to Owoore',
  APPROVAL_REQUEST: (amount: string, fund: string) =>
    `Payout Approval Required — ${amount} ${fund}`,
  APPROVAL_CONFIRMED: (amount: string) =>
    `Payout Approved & Transferred — ${amount}`,
  PAYOUT_DECLINED: 'Payout Request Declined',
  PAYOUT_TRANSFERRED: 'Transfer Successful',
  PAYOUT_FAILED: 'Action Required: Payout Transfer Failed',
  SWEEP_COMPLETED: 'Auto-Sweep Completed',
  PAYMENT_RECEIVED: (fund: string) => `Payment Received — ${fund}`,
  CAMPAIGN_EXPIRY_ALERT: (fund: string) => `Campaign Closing Soon — ${fund}`,
  TREASURER_INVITE: (orgName: string) => `You're invited to ${orgName} on Owoore`,
} as const;

/**
 * testResendConnection — sends a dry-run check so we know Resend
 * is reachable before the first real email needs to go out.
 * Only runs in non-test environments.
 */
export async function testResendConnection(): Promise<void> {
  if (env.NODE_ENV === 'test') return;

  try {
    // Resend doesn't have a ping endpoint — we validate the key
    // by checking the domains list. A 200 means the key is valid.
    await resend.domains.list();
    console.log('[Resend] Email client initialised');
  } catch (err) {
    // Non-fatal — app still starts, but log clearly so it's visible
    console.warn('[Resend] Warning: could not verify API key:', err);
  }
}