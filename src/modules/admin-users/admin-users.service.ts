import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { queryOne } from '../../db';
import { adminUserRepository } from './admin-users.repository';
import { hashToken } from '../../utils/crypto';
import { Errors } from '../../utils/AppError';
import { logger } from '../../utils/logger';
import { env } from '../../config/env';
import { resend, FROM_ADDRESS } from '../../config/resend';

const INVITE_EXPIRY_HOURS = 72;

export const adminUserService = {
  async invite(params: {
    orgId:     string;
    email:     string;
    name:      string;
    role:      'ADMIN' | 'TREASURER';
    invitedBy: string;
  }): Promise<{ adminUserId: string; email: string }> {
    const { orgId, email, name, role, invitedBy } = params;

    const org = await queryOne<{ name: string; slug: string }>(
      `SELECT name, slug FROM organisations WHERE id = $1`,
      [orgId],
    );
    if (!org) throw Errors.notFound('Organisation');

    const existing = await adminUserRepository.findByOrgAndEmail(orgId, email);

    const rawToken = randomUUID();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

    let adminUserId: string;

    if (existing) {
      if (existing.is_active && existing.bcrypt_hash) {
        throw Errors.conflict(
          `${email} already has an active account in this organisation.`,
        );
      }
      await adminUserRepository.updateInviteToken(existing.id, tokenHash, expiresAt);
      adminUserId = existing.id;
    } else {
      const created = await adminUserRepository.createInvited({
        orgId, name, email, role,
        inviteTokenHash: tokenHash,
        expiresAt,
        invitedBy,
      });
      adminUserId = created.id;
    }

    const inviteUrl = `${env.APP_BASE_URL}/invite/${rawToken}`;

    await this.sendInviteEmail({
      to:        email,
      name,
      role,
      orgName:   org.name,
      inviteUrl,
      expiryHours: INVITE_EXPIRY_HOURS,
    });

    logger.info({
      org_id:     orgId,
      invited_email: email.slice(0, 3) + '***',
      role,
      invited_by: invitedBy,
    }, '[AdminUsers] Invite sent');

    return { adminUserId, email };
  },

  async getInviteDetails(rawToken: string): Promise<{
    name: string; email: string; role: string; orgName: string; expired: boolean;
  }> {
    const tokenHash = hashToken(rawToken);
    const user = await adminUserRepository.findByInviteTokenHash(tokenHash);

    if (!user) {
      throw Errors.badRequest('Invalid or expired invite link.');
    }

    const org = await queryOne<{ name: string }>(
      `SELECT name FROM organisations WHERE id = $1`,
      [user.org_id],
    );

    const expired = !!(user.invite_token_expires_at && new Date() > new Date(user.invite_token_expires_at));

    return {
      name:    user.name,
      email:   user.email,
      role:    user.role,
      orgName: org?.name ?? '',
      expired,
    };
  },

  async acceptInvite(rawToken: string, password: string): Promise<{
    token: string;
    admin: { id: string; name: string; email: string; role: string; orgId: string };
    org:   { id: string; name: string; slug: string };
  }> {
    const tokenHash = hashToken(rawToken);
    const user = await adminUserRepository.findByInviteTokenHash(tokenHash);

    if (!user) {
      throw Errors.badRequest('Invalid or expired invite link.');
    }

    if (user.invite_token_expires_at && new Date() > new Date(user.invite_token_expires_at)) {
      throw Errors.badRequest(
        'This invite link has expired. Ask your church admin to send a new one.',
      );
    }

    const bcryptHash = await bcrypt.hash(password, 12);
    await adminUserRepository.activateWithPassword(user.id, bcryptHash);

    const org = await queryOne<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM organisations WHERE id = $1`,
      [user.org_id],
    );

    const { signAdminToken } = await import('../../config/jwt');
    const jwt = signAdminToken({
      sub:   user.id,
      orgId: user.org_id,
      email: user.email,
      role:  user.role as 'ADMIN' | 'TREASURER' | 'SIGNATORY',
    });

    logger.info({
      admin_id: user.id,
      org_id:   user.org_id,
      role:     user.role,
    }, '[AdminUsers] Invite accepted — account activated');

    return {
      token: jwt,
      admin: {
        id:    user.id,
        name:  user.name,
        email: user.email,
        role:  user.role,
        orgId: user.org_id,
      },
      org: {
        id:   org?.id   ?? user.org_id,
        name: org?.name ?? '',
        slug: org?.slug ?? '',
      },
    };
  },

  async sendInviteEmail(params: {
    to: string; name: string; role: string;
    orgName: string; inviteUrl: string; expiryHours: number;
  }): Promise<void> {
    const { to, name, role, orgName, inviteUrl, expiryHours } = params;

    const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr>
        <td style="background:#14532d;padding:24px 32px;">
          <p style="margin:0;color:#fff;font-size:20px;font-weight:600;">Owoore</p>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:13px;">${orgName}</p>
        </td>
      </tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 16px;color:#111827;font-size:15px;">Hi ${name},</p>
        <p style="margin:0 0 24px;color:#374151;line-height:1.6;">
          You've been invited to join <strong>${orgName}</strong> on Owoore as a
          <strong>${role === 'TREASURER' ? 'Treasurer' : 'Admin'}</strong>.
        </p>
        <p style="margin:0 0 8px;color:#374151;font-size:13px;">
          ${role === 'TREASURER'
            ? 'As Treasurer, you can view the dashboard, initiate payouts, and manage fund records.'
            : 'As Admin, you have full access to manage the church on Owoore.'}
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
          <tr><td align="center">
            <a href="${inviteUrl}"
               style="display:inline-block;background:#14532d;color:#fff;text-align:center;
                      padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
              Accept Invite & Set Password
            </a>
          </td></tr>
        </table>
        <p style="margin:0;color:#9ca3af;font-size:11px;border-top:1px solid #f3f4f6;padding-top:16px;">
          This link expires in ${expiryHours} hours. Do not forward this email.<br/>
          If you didn't expect this, you can safely ignore it.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    try {
      await resend.emails.send({
        from:    FROM_ADDRESS,
        to,
        subject: `You're invited to ${orgName} on Owoore`,
        html,
      });
    } catch (err: any) {
      logger.error({ to: to.slice(0, 3) + '***', err: err.message },
        '[AdminUsers] Failed to send invite email');
      throw Errors.internal('Failed to send invite email. Please try again.');
    }
  },
};
