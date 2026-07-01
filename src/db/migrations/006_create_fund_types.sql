-- 006_create_fund_types.sql
-- Fund types are defined by the church admin (e.g. Tithe, Offering, Building Fund).
-- kind RECURRING: permanent fund — no expiry, no expected amount required.
-- kind CAMPAIGN:  time-limited drive — has expires_at and optional expected_amt_kobo.
-- expected_amt_kobo: if set, used as the expectedAmount on each member's Nomba VA
--   so the reconciliation engine can flag underpayments/overpayments automatically.

CREATE TYPE fund_kind AS ENUM ('RECURRING', 'CAMPAIGN');

CREATE TABLE fund_types (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name              VARCHAR(255)  NOT NULL,             -- e.g. 'Building Fund Drive 2026'
  kind              fund_kind     NOT NULL DEFAULT 'RECURRING',
  description       TEXT,
  expected_amt_kobo BIGINT,                             -- per-member pledge amount in kobo
  expires_at        TIMESTAMPTZ,                        -- NULL for RECURRING
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  sort_order        INT           NOT NULL DEFAULT 0,   -- display order on member portal
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, name),

  CONSTRAINT campaign_requires_expiry CHECK (
    kind = 'RECURRING' OR (kind = 'CAMPAIGN' AND expires_at IS NOT NULL)
  ),
  CONSTRAINT expected_amt_positive CHECK (
    expected_amt_kobo IS NULL OR expected_amt_kobo > 0
  )
);

CREATE INDEX idx_fund_types_org_id    ON fund_types(org_id);
CREATE INDEX idx_fund_types_is_active ON fund_types(org_id, is_active);

COMMENT ON TABLE fund_types IS 'Admin-defined collection categories — Tithe, Offering, Building Fund etc.';
COMMENT ON COLUMN fund_types.expected_amt_kobo IS 'Passed to Nomba VA as expectedAmount for reconciliation';
COMMENT ON COLUMN fund_types.expires_at IS 'CAMPAIGN only — VA expiry set to this date on creation';