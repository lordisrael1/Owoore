import bcrypt from 'bcryptjs';
import { queryOne, queryMany } from '../../db';
import { signAdminToken } from '../../config/jwt';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';
import { normaliseEmail, maskEmail } from '../../utils/email';
import { otpService } from './otp.service';
import { adminUserRepository } from '../admin-users/admin-users.repository';
import { emailService } from '../../notifications/email/email.service';
import { auditService } from '../audit/audit.service';

/**
 * admin-auth.service.ts
 *
 * Email + bcrypt password authentication for church admin and treasurer users.
 * These are NOT church members — they manage the dashboard.
 *
 * Security:
 *   - bcrypt cost factor 12 (slow enough to prevent brute force)
 *   - Generic error message on failure (don't reveal if email exists)
 *   - last_login_at updated on every successful login
 *   - Rate limiting enforced in rateLimiter.ts (10 attempts / 15 min)
 */

export const adminAuthService = {
  /**
   * login — validates email + password, returns signed JWT.
   */
  async login(email: string, password: string, orgSlug?: string): Promise<{
    token:    string;
    admin: {
      id:      string;
      name:    string;
      email:   string;
      role:    string;
      orgId:   string;
      orgSlug: string;
    };
  }> {
    // Fetch admin — join with org to get orgId and slug
    const admin = await queryOne<{
      id:          string;
      name:        string;
      email:       string;
      bcrypt_hash: string;
      role:        string;
      is_active:   boolean;
      is_verified: boolean;
      org_id:      string;
      org_slug:    string;
    }>(
      `SELECT a.id, a.name, a.email, a.bcrypt_hash, a.role, a.is_active, a.is_verified,
              a.org_id, o.slug AS org_slug
       FROM admin_users a
       JOIN organisations o ON o.id = a.org_id
       WHERE LOWER(a.email) = LOWER($1)
         AND (o.slug = $2 OR $2 IS NULL)`,
      [email, orgSlug ?? null],
    );

    // Generic error — don't reveal if email exists
    const INVALID_MSG = 'Invalid email or password';

    if (!admin) throw Errors.unauthorized(INVALID_MSG);
    if (!admin.is_active) throw Errors.unauthorized('Your account has been deactivated. Contact your church admin.');

    const passwordMatch = await bcrypt.compare(password, admin.bcrypt_hash);
    if (!passwordMatch) throw Errors.unauthorized(INVALID_MSG);

    // Password is correct, but they haven't proven ownership of the email
    // yet (self-registered and never completed OTP verification).
    if (!admin.is_verified) throw Errors.emailNotVerified(admin.org_slug);

    // Update last_login_at
    await queryOne(
      `UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`,
      [admin.id],
    );

    const token = signAdminToken({
      sub:   admin.id,
      orgId: admin.org_id,
      email: admin.email,
      role:  admin.role as 'ADMIN' | 'TREASURER' | 'SIGNATORY',
    });

    logger.info({
      admin_id: admin.id,
      org_id:   admin.org_id,
      role:     admin.role,
    }, '[AdminAuth] Login successful');

    return {
      token,
      admin: {
        id:      admin.id,
        name:    admin.name,
        email:   admin.email,
        role:    admin.role,
        orgId:   admin.org_id,
        orgSlug: admin.org_slug,
      },
    };
  },

  /**
   * verifyEmail — confirms the OTP sent to a self-registered admin's email
   * and marks the account verified. Logs them straight in (same UX as the
   * member OTP flow) rather than requiring a separate password login right
   * after.
   */
  async verifyEmail(email: string, code: string, orgSlug: string): Promise<{
    token: string;
    admin: { id: string; name: string; email: string; role: string; orgId: string; orgSlug: string };
  }> {
    const normalisedEmail = normaliseEmail(email);

    const org = await queryOne<{ id: string; slug: string }>(
      `SELECT id, slug FROM organisations WHERE slug = $1 AND is_active = TRUE`,
      [orgSlug],
    );
    if (!org) throw Errors.notFound(`Church with join code "${orgSlug}"`);

    const admin = await adminUserRepository.findByOrgAndEmail(org.id, normalisedEmail);
    if (!admin) throw Errors.notFound('Admin account');

    await otpService.checkValid(normalisedEmail, code);
    await otpService.consume(normalisedEmail);

    if (!admin.is_verified) {
      await adminUserRepository.markVerified(admin.id);
    }

    const token = signAdminToken({
      sub:   admin.id,
      orgId: org.id,
      email: admin.email,
      role:  admin.role as 'ADMIN' | 'TREASURER' | 'SIGNATORY',
    });

    logger.info({ admin_id: admin.id, org_id: org.id }, '[AdminAuth] Email verified — account activated');

    return {
      token,
      admin: {
        id:      admin.id,
        name:    admin.name,
        email:   admin.email,
        role:    admin.role,
        orgId:   org.id,
        orgSlug: org.slug,
      },
    };
  },

  /**
   * requestPasswordReset — emails a 6-digit reset code to the admin/treasurer.
   *
   * Always resolves with the same generic message whether or not an account
   * exists for the email — never confirms account existence to a caller.
   * Reuses the OTP infrastructure (10-min TTL, 5 attempts, 3 sends / 15 min).
   */
  async requestPasswordReset(email: string): Promise<{ message: string }> {
    const normalisedEmail = normaliseEmail(email);
    const GENERIC_MSG = `If an account exists for ${maskEmail(normalisedEmail)}, a reset code has been sent.`;

    const admins = await queryMany<{ id: string; org_id: string; is_active: boolean }>(
      `SELECT id, org_id, is_active FROM admin_users WHERE LOWER(email) = LOWER($1)`,
      [normalisedEmail],
    );

    const active = admins.filter((a) => a.is_active);
    if (active.length === 0) {
      // No account (or deactivated) — say nothing, send nothing
      logger.info({ email: maskEmail(normalisedEmail) },
        '[AdminAuth] Password reset requested for unknown/inactive email');
      return { message: GENERIC_MSG };
    }

    const code = await otpService.send(normalisedEmail);

    await emailService.send({
      to:      normalisedEmail,
      subject: 'Reset your Owoore password',
      html: `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
  <tr><td align="center">
    <table width="420" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr>
        <td style="background:#14532d;padding:24px 32px;">
          <p style="margin:0;color:#fff;font-size:20px;font-weight:600;">Owoore</p>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:13px;">Password reset</p>
        </td>
      </tr>
      <tr><td style="padding:32px;text-align:center;">
        <p style="margin:0 0 16px;color:#374151;font-size:14px;">Your password reset code is:</p>
        <p style="margin:0 0 16px;font-size:36px;font-weight:700;letter-spacing:8px;color:#14532d;">${code}</p>
        <p style="margin:0;color:#9ca3af;font-size:12px;">This code expires in 10 minutes. If you didn't request a reset, you can safely ignore this email — your password is unchanged.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
    }, true);

    logger.info({ email: maskEmail(normalisedEmail) },
      '[AdminAuth] Password reset code sent');

    return { message: GENERIC_MSG };
  },

  /**
   * resetPassword — verifies the emailed code and sets a new password.
   *
   * The email is the proven identity here, so the new password applies to
   * every active admin/treasurer account under that email (one per org).
   */
  async resetPassword(email: string, code: string, newPassword: string): Promise<{ message: string }> {
    const normalisedEmail = normaliseEmail(email);

    await otpService.checkValid(normalisedEmail, code);

    const admins = await queryMany<{ id: string; org_id: string; email: string }>(
      `SELECT id, org_id, email FROM admin_users
       WHERE LOWER(email) = LOWER($1) AND is_active = TRUE`,
      [normalisedEmail],
    );
    if (admins.length === 0) {
      // Code was valid but no active account — same shape as a bad code
      throw Errors.badRequest('OTP expired or not found. Please request a new code.');
    }

    await otpService.consume(normalisedEmail);

    const hash = await this.hashPassword(newPassword);
    await queryOne(
      `UPDATE admin_users SET bcrypt_hash = $2, updated_at = NOW()
       WHERE LOWER(email) = LOWER($1) AND is_active = TRUE`,
      [normalisedEmail, hash],
    );

    for (const admin of admins) {
      await auditService.record({
        org_id:      admin.org_id,
        actor_type:  'ADMIN',
        actor_id:    admin.id,
        actor_email: normalisedEmail,
        action:      'ADMIN_PASSWORD_RESET',
        entity_type: 'admin_user',
        entity_id:   admin.id,
        metadata:    { via: 'email_otp' },
      });
    }

    logger.info({ email: maskEmail(normalisedEmail), accounts: admins.length },
      '[AdminAuth] Password reset completed');

    return { message: 'Password updated. You can now sign in with your new password.' };
  },

  /**
   * hashPassword — bcrypt hash for creating admin accounts.
   * Cost factor 12 — ~300ms on modern hardware.
   */
  async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, 12);
  },

  /**
   * createAdmin — creates a new admin user for an org.
   * Called when a church registers on Owoore.
   */
  async createAdmin(input: {
    orgId:    string;
    name:     string;
    email:    string;
    password: string;
    role?:    'ADMIN' | 'TREASURER';
  }): Promise<{ id: string; email: string; role: string }> {
    const hash = await this.hashPassword(input.password);

    const row = await queryOne<{ id: string; email: string; role: string }>(
      `INSERT INTO admin_users (org_id, name, email, bcrypt_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (org_id, email) DO NOTHING
       RETURNING id, email, role`,
      [input.orgId, input.name, input.email, hash, input.role ?? 'ADMIN'],
    );

    if (!row) throw Errors.conflict('An admin with this email already exists in this organisation.');

    logger.info({ org_id: input.orgId, role: input.role ?? 'ADMIN' },
      '[AdminAuth] Admin user created');

    return row;
  },
};