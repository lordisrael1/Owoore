import { queryOne, query } from '../../db';
import { signatoryRepository } from './signatories.repository';
import { Errors } from '../../utils/AppError';
import { logger } from '../../utils/logger';

/**
 * signatory.service.ts
 *
 * Manages payout signatories and the org payout policy.
 *
 * Signatories are the people who must approve payout requests above
 * the threshold (Pastors, Deacons, Elders). Each signatory gets a
 * unique email link when a payout is initiated.
 *
 * Payout policy: min_approvers, threshold_kobo, token_expiry_hours.
 * These are set once by the church admin and apply to all payouts.
 */

export interface PayoutPolicy {
  org_id:             string;
  min_approvers:      number;
  threshold_kobo:     number;
  token_expiry_hours: number;
  auto_decline_hours: number;
}

export const signatoryService = {
  async list(orgId: string) {
    return signatoryRepository.findAllForOrg(orgId);
  },

  async create(orgId: string, input: {
    name:         string;
    email:        string;
    phone?:       string;
    role:         string;
    can_initiate?: boolean;
    can_approve?:  boolean;
  }) {
    // Prevent duplicate email within same org
    const existing = await signatoryRepository.findByEmail(input.email, orgId);
    if (existing) {
      // If they were previously deactivated, reactivate them
      if (!existing.is_active) {
        const reactivated = await signatoryRepository.update(existing.id, orgId, {
          is_active: true, name: input.name, phone: input.phone,
          role: input.role, can_initiate: input.can_initiate,
          can_approve: input.can_approve ?? true,
        });
        logger.info({ signatory_id: existing.id }, '[SignatoryService] Signatory reactivated');
        return reactivated;
      }
      throw Errors.conflict(`A signatory with email "${input.email}" already exists in this church.`);
    }

    const signatory = await signatoryRepository.create({
      org_id:       orgId,
      name:         input.name,
      email:        input.email,
      phone:        input.phone,
      role:         input.role,
      can_initiate: input.can_initiate ?? false,
      can_approve:  input.can_approve  ?? true,
    });

    logger.info({ org_id: orgId, signatory_id: signatory.id, role: input.role },
      '[SignatoryService] Signatory created');

    return signatory;
  },

  async update(id: string, orgId: string, fields: {
    name?:         string;
    phone?:        string;
    role?:         string;
    can_initiate?: boolean;
    can_approve?:  boolean;
  }) {
    const signatory = await signatoryRepository.findById(id, orgId);
    if (!signatory) throw Errors.notFound('Signatory');

    const updated = await signatoryRepository.update(id, orgId, fields);
    logger.info({ signatory_id: id }, '[SignatoryService] Signatory updated');
    return updated;
  },

  async deactivate(id: string, orgId: string) {
    const signatory = await signatoryRepository.findById(id, orgId);
    if (!signatory) throw Errors.notFound('Signatory');

    // Ensure at least one approver remains
    const approvers = await signatoryRepository.findAllForOrg(orgId);
    const activeApprovers = approvers.filter(
      (s) => s.can_approve && s.is_active && s.id !== id,
    );

    const policy = await this.getPolicy(orgId);
    if (activeApprovers.length < policy.min_approvers) {
      throw Errors.badRequest(
        `Cannot deactivate this signatory — you would have fewer active approvers ` +
        `(${activeApprovers.length}) than your minimum required (${policy.min_approvers}). ` +
        'Add another signatory or reduce your minimum approvers first.',
      );
    }

    await signatoryRepository.deactivate(id, orgId);
    logger.info({ signatory_id: id }, '[SignatoryService] Signatory deactivated');
    return { success: true };
  },

  // ── Payout policy ────────────────────────────────────────────────────

  async getPolicy(orgId: string): Promise<PayoutPolicy> {
    const policy = await queryOne<PayoutPolicy>(
      `SELECT * FROM payout_policies WHERE org_id = $1`,
      [orgId],
    );

    // Return defaults if no policy configured yet
    return policy ?? {
      org_id:             orgId,
      min_approvers:      2,
      threshold_kobo:     10_000_000, // ₦100k
      token_expiry_hours: 48,
      auto_decline_hours: 72,
    };
  },

  async updatePolicy(orgId: string, fields: {
    min_approvers?:      number;
    threshold_kobo?:     number;
    token_expiry_hours?: number;
    auto_decline_hours?: number;
  }) {
    // Validate min_approvers against active approver count
    if (fields.min_approvers !== undefined) {
      const approvers = await signatoryRepository.findAllForOrg(orgId);
      const activeApprovers = approvers.filter((s) => s.can_approve);

      if (fields.min_approvers > activeApprovers.length) {
        throw Errors.badRequest(
          `Cannot set minimum approvers to ${fields.min_approvers} — ` +
          `you only have ${activeApprovers.length} active approver(s). Add more signatories first.`,
        );
      }
    }

    const sets: string[]    = ['updated_at = NOW()'];
    const params: unknown[] = [orgId];

    const map: Record<string, unknown> = {
      min_approvers: fields.min_approvers,
      threshold_kobo: fields.threshold_kobo,
      token_expiry_hours: fields.token_expiry_hours,
      auto_decline_hours: fields.auto_decline_hours,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }

    const updated = await queryOne<PayoutPolicy>(
      `UPDATE payout_policies SET ${sets.join(', ')} WHERE org_id = $1 RETURNING *`,
      params,
    );

    if (!updated) throw Errors.notFound('Payout policy — run org setup first');

    logger.info({ org_id: orgId }, '[SignatoryService] Payout policy updated');
    return updated;
  },
};