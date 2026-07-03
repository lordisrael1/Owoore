import { queryOne } from '../../db';

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
}

export const adminUserRepository = {
  async findByOrgAndEmail(orgId: string, email: string): Promise<AdminUserRow | null> {
    return queryOne<AdminUserRow>(
      `SELECT id, org_id, name, email, role, is_active, is_verified,
              invite_token_hash, invite_token_expires_at, invited_by, bcrypt_hash
       FROM admin_users
       WHERE org_id = $1 AND LOWER(email) = LOWER($2)`,
      [orgId, email],
    );
  },

  async findByInviteTokenHash(tokenHash: string): Promise<AdminUserRow | null> {
    return queryOne<AdminUserRow>(
      `SELECT id, org_id, name, email, role, is_active, is_verified,
              invite_token_hash, invite_token_expires_at, invited_by, bcrypt_hash
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
