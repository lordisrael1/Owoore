import { queryOne } from '../../db';

export interface AdminUserRow {
  id:                      string;
  org_id:                  string;
  name:                    string;
  email:                   string;
  role:                    string;
  is_active:               boolean;
  invite_token_hash:       string | null;
  invite_token_expires_at: Date | null;
  invited_by:              string | null;
  bcrypt_hash:             string | null;
}

export const adminUserRepository = {
  async findByOrgAndEmail(orgId: string, email: string): Promise<AdminUserRow | null> {
    return queryOne<AdminUserRow>(
      `SELECT id, org_id, name, email, role, is_active,
              invite_token_hash, invite_token_expires_at, invited_by, bcrypt_hash
       FROM admin_users
       WHERE org_id = $1 AND LOWER(email) = LOWER($2)`,
      [orgId, email],
    );
  },

  async findByInviteTokenHash(tokenHash: string): Promise<AdminUserRow | null> {
    return queryOne<AdminUserRow>(
      `SELECT id, org_id, name, email, role, is_active,
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
    await queryOne(
      `UPDATE admin_users
       SET bcrypt_hash = $2,
           is_active = TRUE,
           invite_token_hash = NULL,
           invite_token_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id, bcryptHash],
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
};
