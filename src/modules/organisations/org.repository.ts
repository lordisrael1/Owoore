import { query, queryOne } from '../../db';

export interface Organisation {
  id:         string;
  name:       string;
  slug:       string;
  logo_url:   string | null;
  is_active:  boolean;
  created_at: Date;
  updated_at: Date;
}

export const orgRepository = {
  async create(input: {
    name:     string;
    slug:     string;
    logo_url?: string;
  }): Promise<Organisation> {
    const row = await queryOne<Organisation>(
      `INSERT INTO organisations (name, slug, logo_url, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, TRUE, NOW(), NOW())
       RETURNING *`,
      [input.name, input.slug, input.logo_url ?? null],
    );
    return row!;
  },

  async findBySlug(slug: string): Promise<Organisation | null> {
    return queryOne<Organisation>(
      `SELECT * FROM organisations WHERE slug = $1 AND is_active = TRUE`,
      [slug],
    );
  },

  async findById(id: string): Promise<Organisation | null> {
    return queryOne<Organisation>(
      `SELECT * FROM organisations WHERE id = $1`,
      [id],
    );
  },

  async update(id: string, fields: { name?: string; logo_url?: string }): Promise<Organisation | null> {
    const sets: string[]   = ['updated_at = NOW()'];
    const params: unknown[] = [id];

    if (fields.name) {
      params.push(fields.name);
      sets.push(`name = $${params.length}`);
    }
    if (fields.logo_url !== undefined) {
      params.push(fields.logo_url);
      sets.push(`logo_url = $${params.length}`);
    }

    return queryOne<Organisation>(
      `UPDATE organisations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
  },

  async slugExists(slug: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM organisations WHERE slug = $1`,
      [slug],
    );
    return row !== null;
  },

  // Create default payout policy for a new org
  async createDefaultPayoutPolicy(orgId: string): Promise<void> {
    await query(
      `INSERT INTO payout_policies (org_id, min_approvers, threshold_kobo, token_expiry_hours, auto_decline_hours)
       VALUES ($1, 2, 10000000, 48, 72)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId],
    );
  },
};