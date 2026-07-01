-- 009_create_anonymous_transactions.sql
-- Inflows to the org-level shared VA (general giving — no member account).
-- Used for: Sunday service projector giving, walk-in visitors, privacy-first members.
-- These count toward the fund total on the dashboard but have no member attribution.
-- The org-level shared VA reference format: org_{org_id}_fund_{fund_type_id}

CREATE TABLE anonymous_transactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID          NOT NULL REFERENCES organisations(id),
  fund_type_id      UUID          NOT NULL REFERENCES fund_types(id),

  -- Amount in kobo
  amount_kobo       BIGINT        NOT NULL CHECK (amount_kobo > 0),

  -- Nomba fields
  nomba_tx_ref      VARCHAR(255)  NOT NULL UNIQUE,       -- idempotency key
  nomba_session_id  VARCHAR(255),
  sender_account    VARCHAR(20),
  sender_bank       VARCHAR(100),
  sender_name       VARCHAR(255),
  narration         TEXT,

  -- Metadata
  period_month      CHAR(7)       NOT NULL,              -- 'YYYY-MM'
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_anon_tx_nomba_tx_ref ON anonymous_transactions(nomba_tx_ref);
CREATE INDEX idx_anon_tx_org_fund            ON anonymous_transactions(org_id, fund_type_id);
CREATE INDEX idx_anon_tx_period              ON anonymous_transactions(org_id, period_month);

COMMENT ON TABLE anonymous_transactions IS
  'Inflows to the shared org-level VA — no member attribution, counts toward fund totals.';