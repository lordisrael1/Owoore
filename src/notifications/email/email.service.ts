import { resend, FROM_ADDRESS } from '../../config/resend';
import { logger } from '../../utils/logger';

/**
 * email.service.ts
 *
 * Resend send wrapper with delivery error handling and bounce logging.
 * All outbound emails in the system go through this single function.
 *
 * Failures are logged as WARN — never re-thrown unless the caller
 * explicitly needs to know (e.g. approval emails on payout initiation).
 *
 * Usage:
 *   await emailService.send({
 *     to: 'pastor@church.org',
 *     subject: 'Payout Approval Required',
 *     html: renderApprovalRequest({ ... }),
 *   });
 */

export interface SendEmailInput {
  to:       string | string[];
  subject:  string;
  html:     string;
  replyTo?: string;
  tags?:    Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  success:  boolean;
  id?:      string;
  error?:   string;
}

export const emailService = {
  /**
   * send — dispatches a single transactional email via Resend.
   *
   * @param input       - email parameters
   * @param throwOnFail - if true, rethrows on failure (use for critical emails
   *                      like approval requests where a missed email = broken flow)
   */
  async send(
    input: SendEmailInput,
    throwOnFail = false,
  ): Promise<SendEmailResult> {
    const { to, subject, html, replyTo, tags } = input;
    const toArr   = Array.isArray(to) ? to : [to];
    const masked  = toArr.map(maskEmail).join(', ');

    try {
      const result = await resend.emails.send({
        from:     FROM_ADDRESS,
        to:       toArr,
        subject,
        html,
        ...(replyTo && { reply_to: replyTo }),
        ...(tags   && { tags }),
      });

      if (result.error) {
        throw new Error(result.error.message ?? 'Resend returned an error');
      }

      logger.info({
        to:         masked,
        subject,
        resend_id:  result.data?.id,
      }, '[Email] Sent successfully');

      return { success: true, id: result.data?.id };

    } catch (err: any) {
      logger.warn({
        to:      masked,
        subject,
        err:     err.message,
      }, '[Email] Send failed');

      if (throwOnFail) throw err;

      return { success: false, error: err.message };
    }
  },

  /**
   * sendMany — sends the same email to multiple recipients individually.
   * Does NOT use BCC — each recipient gets their own email with their own data.
   * Used for approval request emails where each signatory has a unique token link.
   */
  async sendMany(
    recipients: Array<SendEmailInput>,
    throwOnFail = false,
  ): Promise<SendEmailResult[]> {
    return Promise.all(
      recipients.map((r) => this.send(r, throwOnFail)),
    );
  },
};

// Mask email for logs: j***@gmail.com
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}