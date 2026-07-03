import { query } from '../../db';
import { logger } from '../../utils/logger';

/**
 * audit.service.ts — single write path into the append-only audit_log.
 *
 * Every significant event in the system goes through record():
 *   MEMBER_JOINED, PAYMENT_RECEIVED, ANONYMOUS_PAYMENT_RECEIVED,
 *   FUND_CREATED, PAYOUT_INITIATED, PAYOUT_APPROVAL_RECORDED,
 *   PAYOUT_APPROVED, PAYOUT_DECLINED, PAYOUT_TRANSFERRED,
 *   PAYOUT_TRANSFER_FAILED, ADMIN_INVITED
 *
 * Design rules:
 *   - record() NEVER throws. An audit failure must not roll back or
 *     break the business flow it is describing — it logs and moves on.
 *   - metadata carries everything the activity feed needs to render the
 *     event without joins (names, amounts, purposes) — audit rows must
 *     stay readable even after the referenced entity is deleted.
 *   - actor_type 'SIGNATORY' complements the original set
 *     (ADMIN | MEMBER | SYSTEM | WEBHOOK) — the column is VARCHAR, not
 *     a Postgres enum, so no migration is needed.
 */

export type ActorType = 'ADMIN' | 'MEMBER' | 'SIGNATORY' | 'SYSTEM' | 'WEBHOOK';

export interface AuditEntry {
  org_id?:      string | null;
  actor_type:   ActorType;
  actor_id?:    string | null;
  actor_email?: string | null;
  action:       string;
  entity_type:  string;
  entity_id?:   string | null;
  metadata?:    Record<string, unknown>;
}

export const auditService = {
  async record(entry: AuditEntry): Promise<void> {
    try {
      await query(
        `INSERT INTO audit_log
           (org_id, actor_type, actor_id, actor_email,
            action, entity_type, entity_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          entry.org_id ?? null,
          entry.actor_type,
          entry.actor_id ?? null,
          entry.actor_email ?? null,
          entry.action,
          entry.entity_type,
          entry.entity_id ?? null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
        ],
      );
    } catch (err: any) {
      logger.error({ err: err.message, action: entry.action, org_id: entry.org_id },
        '[Audit] Failed to record event — business flow unaffected');
    }
  },
};
