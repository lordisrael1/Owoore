-- 003_create_signatories.sql
-- Signatories are the people who must approve payout requests above the threshold.
-- Typically: Pastor, Deacon, Elder. Configured once by the church admin at setup.
-- A signatory may or may not also be an admin_user — they are separate concepts.
-- Signatories only need an email — they approve via a tokenised link, no login required.

CREATE TABLE signatories (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name          VARCHAR(255)  NOT NULL,
  email         VARCHAR(255)  NOT NULL,
  phone         VARCHAR(20),                        -- used for last-4 digit identity confirm
  role          VARCHAR(100)  NOT NULL,             -- PASTOR | DEACON | ELDER | TRUSTEE
  can_initiate  BOOLEAN       NOT NULL DEFAULT FALSE,  -- can start a payout request
  can_approve   BOOLEAN       NOT NULL DEFAULT TRUE,   -- can approve a payout request
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, email)
);

CREATE INDEX idx_signatories_org_id ON signatories(org_id);

COMMENT ON TABLE signatories IS 'Payout approvers — receive approval-request emails, no login needed';
COMMENT ON COLUMN signatories.can_initiate IS 'Treasurer flag — can start payout but not be sole approver';
COMMENT ON COLUMN signatories.phone IS 'Last 4 digits used to confirm identity on approval page';