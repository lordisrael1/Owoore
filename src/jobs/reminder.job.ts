import { queryMany } from '../db';
import { logger } from '../utils/logger';
import { emailService } from '../notifications/email/email.service';
import { formatNaira } from '../utils/formatMoney';

/**
 * reminder.job.ts — weekly email to members with unpaid expected amounts.
 *
 * Finds all members who have:
 *   - An active fund with expected_amt_kobo set
 *   - Paid less than the expected amount in the current month
 *
 * Sends a gentle reminder email with the deficit and their account number.
 *
 * schedule: '0 9 * * 1'  → 9am every Monday
 */
export async function runReminderJob(): Promise<void> {
  logger.info('[ReminderJob] Starting weekly member reminder run');

  try {
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM

    // Find members with outstanding balances this month
    const members = await queryMany<{
      member_id:        string;
      member_name:      string;
      email:            string;
      fund_name:        string;
      fund_type_id:     string;
      expected_kobo:    number;
      total_paid_kobo:  number;
      deficit_kobo:     number;
      va_number:        string | null;
      bank_name:        string | null;
      org_name:         string;
      org_id:           string;
    }>(
      `SELECT
         m.id         AS member_id,
         m.display_name AS member_name,
         m.email,
         ft.name      AS fund_name,
         ft.id        AS fund_type_id,
         ft.expected_amt_kobo AS expected_kobo,
         o.name       AS org_name,
         o.id         AS org_id,
         COALESCE(SUM(t.amount_kobo), 0)::BIGINT AS total_paid_kobo,
         (ft.expected_amt_kobo - COALESCE(SUM(t.amount_kobo), 0))::BIGINT AS deficit_kobo,
         mfa.nomba_va_number AS va_number,
         mfa.bank_name
       FROM members m
       JOIN organisations o ON o.id = m.org_id
       CROSS JOIN fund_types ft
       LEFT JOIN member_fund_accounts mfa
         ON mfa.member_id = m.id AND mfa.fund_type_id = ft.id
       LEFT JOIN transactions t
         ON t.member_fund_account_id = mfa.id AND t.period_month = $1
       WHERE m.org_id = o.id
         AND ft.org_id = o.id
         AND ft.is_active = TRUE
         AND ft.expected_amt_kobo IS NOT NULL
         AND ft.expected_amt_kobo > 0
         AND m.is_active = TRUE
       GROUP BY m.id, m.display_name, m.email, ft.id, ft.name,
                ft.expected_amt_kobo, o.id, o.name,
                mfa.nomba_va_number, mfa.bank_name
       HAVING COALESCE(SUM(t.amount_kobo), 0) < ft.expected_amt_kobo`,
      [period],
    );

    if (members.length === 0) {
      logger.info('[ReminderJob] No members with outstanding balances this period');
      return;
    }

    logger.info({ count: members.length }, '[ReminderJob] Sending reminders');

    let sent = 0;

    for (const member of members) {
      const deficit  = formatNaira(Number(member.deficit_kobo));
      const expected = formatNaira(Number(member.expected_kobo));
      const paid     = formatNaira(Number(member.total_paid_kobo));

      const html = buildReminderHtml({
        memberName:    member.member_name,
        fundName:      member.fund_name,
        churchName:    member.org_name,
        expectedDisplay: expected,
        paidDisplay:   paid,
        deficitDisplay: deficit,
        vaNumber:      member.va_number ?? '',
        bankName:      member.bank_name ?? '',
        period,
      });

      await emailService.send({
        to:      member.email,
        subject: `Reminder: ${member.fund_name} — ₦${deficit} outstanding`,
        html,
      });

      sent++;
    }

    logger.info({ sent }, '[ReminderJob] Reminder run complete');
  } catch (err: any) {
    logger.error({ err: err.message }, '[ReminderJob] Reminder job failed');
  }
}

function buildReminderHtml(p: {
  memberName: string; fundName: string; churchName: string;
  expectedDisplay: string; paidDisplay: string; deficitDisplay: string;
  vaNumber: string; bankName: string; period: string;
}): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
  <tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr><td style="background:#14532d;padding:20px 28px;">
        <p style="margin:0;color:#fff;font-size:18px;font-weight:600;">Owoore</p>
        <p style="margin:4px 0 0;color:#bbf7d0;font-size:12px;">${p.churchName}</p>
      </td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 12px;color:#111827;">Hi ${p.memberName},</p>
        <p style="margin:0 0 16px;color:#374151;line-height:1.6;">
          This is a friendly reminder about your <strong>${p.fundName}</strong> for this month.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border-radius:8px;margin-bottom:16px;">
          <tr><td style="padding:16px 20px;">
            <table width="100%">
              <tr>
                <td style="color:#6b7280;font-size:12px;padding:3px 0;">Expected</td>
                <td style="color:#1f2937;font-size:13px;text-align:right;font-weight:500;">${p.expectedDisplay}</td>
              </tr>
              <tr>
                <td style="color:#6b7280;font-size:12px;padding:3px 0;">Paid this month</td>
                <td style="color:#166534;font-size:13px;text-align:right;font-weight:500;">${p.paidDisplay}</td>
              </tr>
              <tr>
                <td style="color:#9a3412;font-size:12px;font-weight:500;padding:3px 0;">Outstanding</td>
                <td style="color:#9a3412;font-size:15px;text-align:right;font-weight:700;">${p.deficitDisplay}</td>
              </tr>
            </table>
          </td></tr>
        </table>
        ${p.vaNumber ? `
        <p style="margin:0 0 8px;color:#374151;font-size:13px;">Transfer to your dedicated account:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ff;border-radius:8px;margin-bottom:16px;">
          <tr><td style="padding:14px 18px;text-align:center;">
            <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:3px;color:#3730a3;">${p.vaNumber}</p>
            <p style="margin:4px 0 0;color:#6b7280;font-size:12px;">${p.bankName} — ${p.fundName}</p>
          </td></tr>
        </table>` : ''}
        <p style="margin:0;color:#9ca3af;font-size:11px;border-top:1px solid #f3f4f6;padding-top:16px;">
          This is an automated reminder from Owoore · ${p.churchName}
        </p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}