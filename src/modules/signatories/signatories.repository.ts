import { queryOne, queryMany } from '../../db';

export interface Signatory {
  id:           string;
  org_id:       string;
  name:         string;
  email:        string;
  phone:        string | null;
  role:         string;
  can_initiate: boolean;
  can_approve:  boolean;
  is_active:    boolean;
  created_at:   Date;
  updated_at:   Date;
}

export const signatoryRepository = {
  async findAllForOrg(org_id: string, activeOnly = true): Promise<Signatory[]> {
    return queryMany<Signatory>(
      `SELECT * FROM signatories
       WHERE org_id = $1 ${activeOnly ? 'AND is_active = TRUE' : ''}
       ORDER BY created_at ASC`,
      [org_id],
    );
  },

  async findById(id: string, org_id: string): Promise<Signatory | null> {
    return queryOne<Signatory>(
      `SELECT * FROM signatories WHERE id = $1 AND org_id = $2`,
      [id, org_id],
    );
  },

  async findByEmail(email: string, org_id: string): Promise<Signatory | null> {
    return queryOne<Signatory>(
      `SELECT * FROM signatories WHERE LOWER(email) = LOWER($1) AND org_id = $2`,
      [email, org_id],
    );
  },

  async create(input: {
    org_id:       string;
    name:         string;
    email:        string;
    phone?:       string;
    role:         string;
    can_initiate: boolean;
    can_approve:  boolean;
  }): Promise<Signatory> {
    const row = await queryOne<Signatory>(
      `INSERT INTO signatories
         (org_id, name, email, phone, role, can_initiate, can_approve, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),NOW())
       RETURNING *`,
      [
        input.org_id, input.name, input.email, input.phone ?? null,
        input.role, input.can_initiate, input.can_approve,
      ],
    );
    return row!;
  },

  async update(id: string, org_id: string, fields: {
    name?:         string;
    phone?:        string;
    role?:         string;
    can_initiate?: boolean;
    can_approve?:  boolean;
    is_active?:    boolean;
  }): Promise<Signatory | null> {
    const sets: string[]    = ['updated_at = NOW()'];
    const params: unknown[] = [id, org_id];

    const map: Record<string, unknown> = {
      name: fields.name, phone: fields.phone, role: fields.role,
      can_initiate: fields.can_initiate, can_approve: fields.can_approve,
      is_active: fields.is_active,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }

    return queryOne<Signatory>(
      `UPDATE signatories SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
      params,
    );
  },

  async deactivate(id: string, org_id: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>(
      `UPDATE signatories SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND org_id = $2 RETURNING id`,
      [id, org_id],
    );
    return row !== null;
  },
};