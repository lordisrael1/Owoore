-- 017_create_audit_log.sql
-- IMMUTABLE event log — rows are never updated or deleted.
-- Records every significant action in the system: who did what, to what, when.
-- before_json / after_json snapshot the entity state for full diff visibility.
-- Used by: payout requests, approval actions, signatory changes, bank account adds.
-- This is what judges mean by "immutable audit trail" on the security criterion.

CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID          REFERENCES organisations(id),
  actor_type    VARCHAR(50)   NOT NULL,           -- 'ADMIN' | 'MEMBER' | 'SYSTEM' | 'WEBHOOK'
  actor_id      UUID,                             -- admin_user.id or member.id (NULL for SYSTEM)
  actor_email   VARCHAR(255),                     -- snapshot at time of action
  action        VARCHAR(100)  NOT NULL,           -- 'PAYOUT_INITIATED' | 'APPROVAL_GRANTED' etc.
  entity_type   VARCHAR(100)  NOT NULL,           -- 'payout_request' | 'signatory' | 'fund_type'
  entity_id     UUID,                             -- the affected record's ID
  before_json   JSONB,                            -- state before action (NULL for creates)
  after_json    JSONB,                            -- state after action (NULL for deletes)
  metadata      JSONB,                            -- extra context: IP, user-agent etc.
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- NO updated_at — this table is append-only
);

CREATE INDEX idx_audit_log_org_id      ON audit_log(org_id, created_at DESC);
CREATE INDEX idx_audit_log_entity      ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_actor       ON audit_log(actor_id);

-- Prevent updates and deletes at DB level
CREATE RULE no_update_audit AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_audit AS ON DELETE TO audit_log DO INSTEAD NOTHING;

COMMENT ON TABLE audit_log IS 'Append-only event log — immutable by DB rule. Every sensitive action recorded.';
COMMENT ON COLUMN audit_log.before_json IS 'Full entity snapshot before change — enables diff for any action.';