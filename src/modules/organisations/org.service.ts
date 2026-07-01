import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';
import { generateUniqueSlug } from '../../utils/slug';
import { orgRepository } from './org.repository';
import { adminAuthService } from '../auth/admin-auth.service';
import { withTransaction } from '../../db';

export const orgService = {
  /**
   * create — full church onboarding sequence.
   * Transactional: if any step fails, all DB writes roll back.
   */
  async create(input: {
    name:          string;
    adminName:     string;
    adminEmail:    string;
    adminPassword: string;
    logoUrl?:      string;
  }): Promise<{
    org:   { id: string; name: string; slug: string };
    admin: { id: string; email: string; role: string };
    joinLink: string;
  }> {
    const { name, adminName, adminEmail, adminPassword, logoUrl } = input;

    const slug = await generateUniqueSlug(name);

    let org: any;
    let admin: any;

    await withTransaction(async (client) => {
      const orgRow = await client.query<{
        id: string; name: string; slug: string;
      }>(
        `INSERT INTO organisations (name, slug, logo_url, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, TRUE, NOW(), NOW())
         RETURNING id, name, slug`,
        [name, slug, logoUrl ?? null],
      );
      org = orgRow.rows[0];

      // Create admin user
      const bcryptHash = await adminAuthService.hashPassword(adminPassword);
      const adminRow   = await client.query<{ id: string; email: string; role: string }>(
        `INSERT INTO admin_users (org_id, name, email, bcrypt_hash, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'ADMIN', NOW(), NOW())
         RETURNING id, email, role`,
        [org.id, adminName, adminEmail, bcryptHash],
      );
      admin = adminRow.rows[0];

      // Default payout policy: ₦100k threshold, 2 approvers needed, 48h token expiry
      await client.query(
        `INSERT INTO payout_policies
           (org_id, min_approvers, threshold_kobo, token_expiry_hours, auto_decline_hours)
         VALUES ($1, 2, 10000000, 48, 72)`,
        [org.id],
      );

      // Tithe: per-member VA, fully tracked. Offering: one shared VA for
      // the whole org — no per-member giving history.
      await client.query(
        `INSERT INTO fund_types (org_id, name, kind, sort_order, is_active, is_shared_va, created_at, updated_at)
         VALUES
           ($1, 'Tithe',    'RECURRING', 1, TRUE, FALSE, NOW(), NOW()),
           ($1, 'Offering', 'RECURRING', 2, TRUE, TRUE,  NOW(), NOW())`,
        [org.id],
      );
    });

    const joinLink = `${env.APP_BASE_URL}/join/${slug}`;

    logger.info({ org_id: org.id, slug }, '[OrgService] Church registered successfully');

    return {
      org:      { id: org.id, name: org.name, slug: org.slug },
      admin:    { id: admin.id, email: admin.email, role: admin.role },
      joinLink,
    };
  },

  async getBySlug(slug: string) {
    const org = await orgRepository.findBySlug(slug);
    if (!org) throw Errors.notFound(`Church with join code "${slug}"`);
    return org;
  },

  async update(orgId: string, fields: { name?: string; logo_url?: string }) {
    const updated = await orgRepository.update(orgId, fields);
    if (!updated) throw Errors.notFound('Organisation');
    return updated;
  },
};