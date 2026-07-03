-- 028_drop_audit_log_org_fk.sql
-- audit_log rows are immutable (no_update/no_delete rules from 017), which
-- combined with the org_id FOREIGN KEY made any organisation with audit
-- history permanently undeletable — the FK blocks the delete and the rules
-- block removing the audit rows.
--
-- An audit trail must not hold referential locks on operational data:
-- it already snapshots actor_email / names / amounts in metadata precisely
-- so rows stay meaningful after the referenced entities are gone.
-- actor_id and entity_id were already plain UUIDs with no FK — org_id now
-- matches that design.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_org_id_fkey;

COMMENT ON COLUMN audit_log.org_id IS
  'Org the event belongs to — plain UUID, no FK. Audit history outlives the org.';
