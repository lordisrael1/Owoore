import bcrypt from 'bcryptjs';
import { queryOne } from '../../db';
import { signAdminToken } from '../../config/jwt';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';

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
      org_id:      string;
      org_slug:    string;
    }>(
      `SELECT a.id, a.name, a.email, a.bcrypt_hash, a.role, a.is_active,
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