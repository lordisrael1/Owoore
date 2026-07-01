-- 004_create_payout_policy.sql
-- One policy row per organisation. Defines the governance rules for payouts.
-- min_approvers: how many signatories must approve before transfer fires.
-- threshold_kobo: amounts above this require multi-approver flow; below = manual direct.
-- token_expiry_hours: how long an approval link stays valid (default 48).
-- auto_decline_hours: if quorum not reached in this time, request auto-declines (default 72).

CREATE TABLE payout_policies (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE UNIQUE,
  min_approvers         INT           NOT NULL DEFAULT 2,
  threshold_kobo        BIGINT        NOT NULL DEFAULT 10000000,  -- ₦100,000 in kobo
  token_expiry_hours    INT           NOT NULL DEFAULT 48,
  auto_decline_hours    INT           NOT NULL DEFAULT 72,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT min_approvers_positive CHECK (min_approvers >= 1),
  CONSTRAINT threshold_positive      CHECK (threshold_kobo > 0),
  CONSTRAINT token_expiry_valid      CHECK (token_expiry_hours BETWEEN 1 AND 168),
  CONSTRAINT auto_decline_after_token CHECK (auto_decline_hours >= token_expiry_hours)
);

COMMENT ON TABLE payout_policies IS 'Per-org treasury governance rules — M-of-N approvals, threshold';
COMMENT ON COLUMN payout_policies.threshold_kobo IS 'Amounts above this need multi-approver. Below = direct manual transfer.';
COMMENT ON COLUMN payout_policies.min_approvers IS 'Minimum approvals needed from eligible signatories (excludes initiator)';