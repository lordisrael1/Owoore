import { queryOne } from '../../db';
import { signMemberToken, refreshMemberToken } from '../../config/jwt';
import { memberCode } from '../../utils/generateRefrence';
import { normaliseEmail, maskEmail } from '../../utils/email';
import { otpService } from './otp.service';
import { emailService } from '../../notifications/email/email.service';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';
import { env } from '../../config/env';

export const authService = {
  async sendOtp(email: string, orgSlug: string): Promise<{ message: string }> {
    const normalisedEmail = normaliseEmail(email);

    const org = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM organisations WHERE slug = $1 AND is_active = TRUE`,
      [orgSlug],
    );

    if (!org) throw Errors.notFound(`Church with join code "${orgSlug}"`);

    const code = await otpService.send(normalisedEmail);

    if (env.NODE_ENV === 'development') {
      logger.info({
        email: normalisedEmail,
        otp:   code,
        org:   org.name,
      }, '[Auth] OTP generated (DEV — also check logs)');
    }

    await this.deliverOtp(normalisedEmail, code, org.name);

    return { message: `Verification code sent to ${maskEmail(normalisedEmail)}` };
  },

  async verifyOtp(
    email:   string,
    code:    string,
    orgSlug: string,
    name:    string,
  ): Promise<{
    token:  string;
    member: { id: string; name: string; email: string; memberCode: string; orgId: string; orgSlug: string; isNew: boolean };
  }> {
    const normalisedEmail = normaliseEmail(email);

    const org = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM organisations WHERE slug = $1 AND is_active = TRUE`,
      [orgSlug],
    );
    if (!org) throw Errors.notFound(`Church with join code "${orgSlug}"`);

    // Confirm the code is correct, but don't consume it yet — a new
    // member without a name supplied yet needs to retry this same code.
    await otpService.checkValid(normalisedEmail, code);

    let member = await queryOne<{
      id: string; display_name: string; member_code: string;
    }>(
      `SELECT id, display_name, member_code
       FROM members WHERE email = $1 AND org_id = $2`,
      [normalisedEmail, org.id],
    );

    let isNew = false;

    if (!member) {
      if (!name?.trim()) {
        // OTP is still valid/untouched — frontend resubmits with name.
        throw Errors.badRequest(
          'Display name is required for first-time registration. Include "name" in your request.',
        );
      }

      const countRow = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM members WHERE org_id = $1`,
        [org.id],
      );
      const mCode = memberCode(Number(countRow?.count ?? 0));

      member = await queryOne<{ id: string; display_name: string; member_code: string }>(
        `INSERT INTO members (org_id, email, display_name, member_code, joined_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, display_name, member_code`,
        [org.id, normalisedEmail, name.trim(), mCode],
      );

      isNew = true;
      logger.info({ org_id: org.id, member_code: mCode }, '[Auth] New member registered');
    } else {
      logger.info({ member_id: member.id }, '[Auth] Existing member verified');
    }

    // Member is fully resolved — only now is the OTP actually spent.
    await otpService.consume(normalisedEmail);

    const token = signMemberToken({
      sub:   member!.id,
      orgId: org.id,
      email: normalisedEmail,
      role:  'MEMBER',
    });

    return {
      token,
      member: {
        id:         member!.id,
        name:       member!.display_name,
        email:      normalisedEmail,
        memberCode: member!.member_code,
        orgId:      org.id,
        orgSlug:    orgSlug,
        isNew,
      },
    };
  },

  async refresh(existingToken: string): Promise<{ token: string }> {
    const newToken = refreshMemberToken(existingToken);
    return { token: newToken };
  },

  async deliverOtp(email: string, code: string, churchName: string): Promise<void> {
    const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
  <tr><td align="center">
    <table width="420" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr>
        <td style="background:#14532d;padding:24px 32px;">
          <p style="margin:0;color:#fff;font-size:20px;font-weight:600;">Owoore</p>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:13px;">${churchName}</p>
        </td>
      </tr>
      <tr><td style="padding:32px;text-align:center;">
        <p style="margin:0 0 16px;color:#374151;font-size:14px;">Your verification code is:</p>
        <p style="margin:0 0 16px;font-size:36px;font-weight:700;letter-spacing:8px;color:#14532d;">${code}</p>
        <p style="margin:0;color:#9ca3af;font-size:12px;">This code expires in 10 minutes. Do not share it with anyone.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    await emailService.send({
      to:      email,
      subject: `Your Owoore verification code`,
      html,
    }, true);
  },
};
