import { fundRepository } from './fund.repository'
import { Errors } from '../../utils/AppError';
import { logger } from '../../utils/logger';
import { auditService } from '../audit/audit.service';

/**
 * fund.service.ts
 *
 * Business logic for fund type management.
 *
 * Fund types are the collection categories defined by the church admin:
 *   RECURRING — permanent (Tithe, Offering) — no expiry, any amount accepted
 *   CAMPAIGN  — time-limited (Building Fund Drive 2026) — has expiry + optional pledge
 *
 * expected_amt_kobo: if set, passed to Nomba as expectedAmount on each member VA
 * so the reconciliation engine can flag underpayment/overpayment automatically.
 */
export const fundService = {
  async create(orgId: string, input: {
    name:          string;
    kind:          'RECURRING' | 'CAMPAIGN';
    description?:  string;
    expected_amt?: number;
    expires_at?:   string;
  }, actor?: { id: string; email?: string }) {
    // Check name uniqueness within this org
    const existing = await fundRepository.findAllForOrg(orgId, false);
    const nameTaken = existing.some(
      (f) => f.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (nameTaken) {
      throw Errors.conflict(`A fund named "${input.name}" already exists in this church.`);
    }

    // Validate CAMPAIGN has expiry
    if (input.kind === 'CAMPAIGN' && !input.expires_at) {
      throw Errors.badRequest('Campaign funds must have an expiry date.');
    }

    const sortOrder = existing.length + 1;

    const fund = await fundRepository.create({
      org_id:       orgId,
      name:         input.name,
      kind:         input.kind,
      description:  input.description,
      expected_amt: input.expected_amt,
      expires_at:   input.expires_at ? new Date(input.expires_at) : undefined,
      sort_order:   sortOrder,
    });

    logger.info({ org_id: orgId, fund_id: fund.id, name: fund.name, kind: fund.kind },
      '[FundService] Fund type created');

    await auditService.record({
      org_id:      orgId,
      actor_type:  'ADMIN',
      actor_id:    actor?.id,
      actor_email: actor?.email,
      action:      'FUND_CREATED',
      entity_type: 'fund_type',
      entity_id:   fund.id,
      metadata: {
        fund_name:  fund.name,
        kind:       fund.kind,
        expires_at: input.expires_at,
      },
    });

    return fund;
  },

  async list(orgId: string, includeInactive = false) {
    return fundRepository.findAllForOrg(orgId, !includeInactive);
  },

  async getById(id: string, orgId: string) {
    const fund = await fundRepository.findById(id, orgId);
    if (!fund) throw Errors.notFound('Fund type');
    return fund;
  },

  async update(id: string, orgId: string, fields: {
    name?:         string;
    description?:  string;
    expected_amt?: number;
    expires_at?:   string;
    sort_order?:   number;
    is_active?:    boolean;
    is_shared_va?: boolean;
  }) {
    const fund = await fundRepository.findById(id, orgId);
    if (!fund) throw Errors.notFound('Fund type');

    // Prevent re-activating an expired campaign
    if (fields.is_active === true && fund.kind === 'CAMPAIGN') {
      if (fund.expires_at && new Date() > new Date(fund.expires_at)) {
        throw Errors.badRequest(
          'Cannot reactivate an expired campaign. Update the expiry date first.',
        );
      }
    }

    const updated = await fundRepository.update(id, orgId, {
      ...fields,
      expires_at: fields.expires_at ? new Date(fields.expires_at) : undefined,
    });

    logger.info({ fund_id: id, org_id: orgId }, '[FundService] Fund type updated');
    return updated;
  },

  async deactivate(id: string, orgId: string) {
    const fund = await fundRepository.findById(id, orgId);
    if (!fund) throw Errors.notFound('Fund type');

    const success = await fundRepository.deactivate(id, orgId);
    if (!success) throw Errors.internal('Failed to deactivate fund type');

    logger.info({ fund_id: id, org_id: orgId }, '[FundService] Fund type deactivated');
    return { success: true, message: `"${fund.name}" has been deactivated.` };
  },
};