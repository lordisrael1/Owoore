import { queryOne, queryMany } from '../../db';

export interface AdminUserRow {
  id:                      string;
  org_id:                  string;
  name:                    string;
  email:                   string;
  role:                    string;
  is_active:               boolean;
  is_verified:             boolean;
  invite_token_hash:       string | null;
  invite_token_expires_at: Date | null;
  invited_by:              string | null;
  bcrypt_hash:             string | null;
  token_version:           number;
}

export interface TeamMemberRow {
  id:                 string;
  name:               string;
  email:              string;
  role:               string;
  is_active:          boolean;
  is_verified:        boolean;
  has_password:       boolean;
  has_pending_invite: boolean;
  invite_expires_at:  Date | null;
  invited_by_name:    string | null;
  created_at:         Date;
}

export const adminUserRepository = {
  /**
   * listByOrg — every human staff account for the team page.
   * The per-org SYSTEM actor (sweep attribution) is excluded — it can
   * never log in and would only confuse the list.
   */
  async listByOrg(orgId: string): Promise<TeamMemberRow[]> {
    return queryMany<TeamMemberRow>(
      `SELECT au.id, au.name, au.email, au.role, au.is_active, au.is_verified,
              (au.bcrypt_hash IS NOT NULL)       AS has_password,
              (au.invite_token_hash IS NOT NULL) AS has_pending_invite,
              au.invite_token_expires_at         AS invite_expires_at,
              inviter.name                       AS invited_by_name,
              au.created_at
       FROM admin_users au
       LEFT JOIN admin_users inviter ON inviter.id = au.invited_by
       WHERE au.org_id = $1 AND au.role <> 'SYSTEM'
       ORDER BY au.created_at ASC`,
      [orgId],
    );
  },

  async findByIdInOrg(id: string, orgId: string): Promise<AdminUserRow | null> {
    return queryOne<AdminUserRow>(
      `SELECT id, org_id, name, email, role, is_active, is_verified,
              invite_token_hash, invite_token_expires_at, invited_by, bcrypt_hash,
              token_version
       FROM admin_users
       WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
  },

  /**
   * setActive — flips dashboard access. When deactivating, also bumps
   * token_version so any session this person is CURRENTLY using dies on
   * their next request instead of surviving up to the JWT's natural
   * expiry — closing/revoking is otherwise cosmetic against a stateless
   * JWT (see 032_add_token_version_to_admin_users.sql).
   */
  async setActive(id: string, orgId: string, isActive: boolean): Promise<void> {
    await queryOne(
      `UPDATE admin_users
       SET is_active     = $3,
           updated_at    = NOW(),
           token_version = CASE WHEN $3 = FALSE THEN token_version + 1 ELSE token_version END
       WHERE id = $1 AND org_id = $2`,
      [id, orgId, isActive],
    );
  },

  /**
   * bumpTokenVersion — invalidates every JWT issued for this admin before
   * this call, everywhere, on their next authenticated request (subject
   * to the ~30s Redis cache in authenticate.ts). Used by self-service
   * logout and by setActive's revoke path.
   */
  async bumpTokenVersion(id: string): Promise<number> {
    const row = await queryOne<{ token_version: number }>(
      `UPDATE admin_users SET token_version = token_version + 1, updated_at = NOW()
       WHERE id = $1 RETURNING token_version`,
      [id],
    );
    return row!.token_version;
  },

  async countActiveAdmins(orgId: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
       FROM admin_users
       WHERE org_id = $1 AND role = 'ADMIN' AND is_active = TRUE`,
      [orgId],
    );
    return Number(row?.count ?? 0);
  },

  async findByOrgAndEmail(orgId: string, email: string): Promise<AdminUserRow | null> {
    return queryOne<AdminUserRow>(
      `SELECT id, org_id, name, email, role, is_active, is_verified,
              invite_token_hash, invite_token_expires_at, invited_by, bcrypt_hash,
              token_version
       FROM admin_users
       WHERE org_id = $1 AND LOWER(email) = LOWER($2)`,
      [orgId, email],
    );
  },

  async findByInviteTokenHash(tokenHash: string): Promise<AdminUserRow | null> {
    return queryOne<AdminUserRow>(
      `SELECT id, org_id, name, email, role, is_active, is_verified,
              invite_token_hash, invite_token_expires_at, invited_by, bcrypt_hash,
              token_version
       FROM admin_users
       WHERE invite_token_hash = $1`,
      [tokenHash],
    );
  },

  async createInvited(params: {
    orgId:           string;
    name:            string;
    email:           string;
    role:            string;
    inviteTokenHash: string;
    expiresAt:       Date;
    invitedBy:       string;
  }): Promise<{ id: string; email: string; role: string }> {
    const row = await queryOne<{ id: string; email: string; role: string }>(
      `INSERT INTO admin_users
         (org_id, name, email, role, is_active, invite_token_hash, invite_token_expires_at, invited_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, NOW(), NOW())
       RETURNING id, email, role`,
      [params.orgId, params.name, params.email, params.role,
       params.inviteTokenHash, params.expiresAt, params.invitedBy],
    );
    return row!;
  },

  async activateWithPassword(id: string, bcryptHash: string): Promise<void> {
    // Clicking the emailed invite link already proves ownership of the
    // mailbox — no separate OTP verification needed for invited users.
    await queryOne(
      `UPDATE admin_users
       SET bcrypt_hash = $2,
           is_active = TRUE,
           is_verified = TRUE,
           invite_token_hash = NULL,
           invite_token_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id, bcryptHash],
    );
  },

  async markVerified(id: string): Promise<void> {
    await queryOne(
      `UPDATE admin_users SET is_verified = TRUE, updated_at = NOW() WHERE id = $1`,
      [id],
    );
  },

  async updateInviteToken(id: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await queryOne(
      `UPDATE admin_users
       SET invite_token_hash = $2,
           invite_token_expires_at = $3,
           is_active = FALSE,
           updated_at = NOW()
       WHERE id = $1`,
      [id, tokenHash, expiresAt],
    );
  },

  /**
   * getOrCreateSystemActor — designated per-org system account used as
   * initiated_by on system-generated payouts (auto-sweeps).
   *
   * payout_requests.initiated_by is NOT NULL REFERENCES admin_users(id),
   * so system flows need a real row to attribute to. This account can
   * never log in: bcrypt_hash is NULL and is_active is FALSE. Role
   * 'SYSTEM' keeps it distinguishable from human ADMIN/TREASURER rows.
   *
   * Idempotent via the UNIQUE(org_id, email) constraint — the DO UPDATE
   * no-op lets RETURNING work on the existing row.
   */
  async getOrCreateSystemActor(orgId: string): Promise<string> {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO admin_users
         (org_id, name, email, role, is_active, is_verified, created_at, updated_at)
       VALUES ($1, 'Owoore System', 'system@owoore.internal', 'SYSTEM', FALSE, TRUE, NOW(), NOW())
       ON CONFLICT (org_id, email) DO UPDATE SET updated_at = admin_users.updated_at
       RETURNING id`,
      [orgId],
    );
    return row!.id;
  },
};
