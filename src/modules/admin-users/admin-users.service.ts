import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { queryOne } from '../../db';
import { adminUserRepository } from './admin-users.repository';
import { hashToken } from '../../utils/crypto';
import { Errors } from '../../utils/AppError';
import { logger } from '../../utils/logger';
import { env } from '../../config/env';
import { emailService } from '../../notifications/email/email.service';
import { auditService } from '../audit/audit.service';

const INVITE_EXPIRY_HOURS = 72;

export type TeamMemberStatus = 'ACTIVE' | 'INVITED' | 'INVITE_EXPIRED' | 'DEACTIVATED';

export const adminUserService = {
  /**
   * listTeam — staff roster for the team management page.
   * Status is derived, not stored:
   *   ACTIVE         — can log in
   *   INVITED        — invite sent, not yet accepted, link still valid
   *   INVITE_EXPIRED — invite sent but the 72 h window passed
   *   DEACTIVATED    — had an account, access revoked
   */
  async listTeam(orgId: string) {
    const rows = await adminUserRepository.listByOrg(orgId);

    return rows.map((r) => {
      let status: TeamMemberStatus;
      if (r.is_active) {
        status = 'ACTIVE';
      } else if (r.has_pending_invite) {
        status = r.invite_expires_at && new Date() > new Date(r.invite_expires_at)
          ? 'INVITE_EXPIRED'
          : 'INVITED';
      } else {
        status = 'DEACTIVATED';
      }

      return {
        id:               r.id,
        name:             r.name,
        email:            r.email,
        role:             r.role,
        status,
        is_verified:      r.is_verified,
        invited_by_name:  r.invited_by_name,
        created_at:       r.created_at,
      };
    });
  },

  /**
   * setActive — revoke or restore a team member's dashboard access.
   *
   * Guards (in order):
   *   - target must exist in the actor's org (multi-tenant scope)
   *   - the SYSTEM actor is untouchable
   *   - you cannot deactivate yourself
   *   - the last active ADMIN cannot be deactivated (org lockout)
   *   - an account that never set a password cannot be "reactivated" —
   *     resend the invite instead
   */
  async setActive(params: {
    orgId:      string;
    actorId:    string;
    actorEmail: string;
    targetId:   string;
    isActive:   boolean;
  }): Promise<{ id: string; is_active: boolean }> {
    const { orgId, actorId, actorEmail, targetId, isActive } = params;

    const target = await adminUserRepository.findByIdInOrg(targetId, orgId);
    if (!target) throw Errors.notFound('Team member');

    if (target.role === 'SYSTEM') {
      throw Errors.forbidden('This account is managed by Owoore and cannot be changed.');
    }

    if (targetId === actorId && !isActive) {
      throw Errors.badRequest('You cannot deactivate your own account.');
    }

    if (!isActive && target.role === 'ADMIN' && target.is_active) {
      const activeAdmins = await adminUserRepository.countActiveAdmins(orgId);
      if (activeAdmins <= 1) {
        throw Errors.badRequest(
          'This is the last active admin. Promote or invite another admin before deactivating this one.',
        );
      }
    }

    if (isActive && !target.bcrypt_hash) {
      throw Errors.badRequest(
        'This person has not accepted their invite yet — send a new invite instead.',
      );
    }

    await adminUserRepository.setActive(targetId, orgId, isActive);

    if (!isActive) {
      // setActive already bumped token_version in the DB when isActive is
      // false — evict the cached copy so the revoke takes effect on this
      // person's very next request instead of waiting out the cache TTL.
      const { evictAdminTokenVersionCache } = await import('../../config/jwt');
      await evictAdminTokenVersionCache(targetId);
    }

    logger.info({
      org_id:    orgId,
      target_id: targetId,
      is_active: isActive,
      actor_id:  actorId,
    }, `[AdminUsers] Account ${isActive ? 'reactivated' : 'deactivated'}`);

    await auditService.record({
      org_id:      orgId,
      actor_type:  'ADMIN',
      actor_id:    actorId,
      actor_email: actorEmail,
      action:      isActive ? 'ADMIN_REACTIVATED' : 'ADMIN_DEACTIVATED',
      entity_type: 'admin_user',
      entity_id:   targetId,
      metadata: {
        target_name:  target.name,
        target_email: target.email,
        target_role:  target.role,
      },
    });

    return { id: targetId, is_active: isActive };
  },

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

    await auditService.record({
      org_id:      orgId,
      actor_type:  'ADMIN',
      actor_id:    invitedBy,
      action:      'ADMIN_INVITED',
      entity_type: 'admin_user',
      entity_id:   adminUserId,
      metadata: {
        invitee_name:  name,
        invitee_email: email,
        role,
        org_name:      org.name,
      },
    });

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
      sub:          user.id,
      orgId:        user.org_id,
      email:        user.email,
      role:         user.role as 'ADMIN' | 'TREASURER' | 'SIGNATORY',
      tokenVersion: user.token_version,
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
      // Must throw on failure — Resend's SDK resolves with { error } instead
      // of rejecting for most API-level failures (unverified sender, bad
      // recipient, rate limits, etc). Calling resend.emails.send() directly
      // here previously ignored that `error` field, so a rejected send
      // looked identical to a successful one and this whole catch block
      // was dead code.
      await emailService.send({
        to,
        subject: `You're invited to ${orgName} on Owoore`,
        html,
      }, true);
    } catch (err: any) {
      logger.error({ to: to.slice(0, 3) + '***', err: err.message },
        '[AdminUsers] Failed to send invite email');
      throw Errors.internal('Failed to send invite email. Please try again.');
    }
  },
};
