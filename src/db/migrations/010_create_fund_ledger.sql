-- 010_create_fund_ledger.sql
-- Running balance per fund per period. Updated atomically on every transaction write.
-- soft_lock_kobo: amount held pending a payout approval — excluded from available balance.
-- available_kobo = total_collected_kobo - total_paid_out_kobo - soft_lock_kobo
-- This is the source of truth for "how much money is in this fund right now".

CREATE TABLE fund_ledger (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  fund_type_id          UUID          NOT NULL REFERENCES fund_types(id)    ON DELETE CASCADE,

  -- Running totals — all in kobo
  total_collected_kobo  BIGINT        NOT NULL DEFAULT 0,   -- all inflows including anonymous
  total_paid_out_kobo   BIGINT        NOT NULL DEFAULT 0,   -- all completed payout transfers
  soft_lock_kobo        BIGINT        NOT NULL DEFAULT 0,   -- pending payout approvals

  -- Member-level aggregates (updated on each transaction)
  member_count_paid     INT           NOT NULL DEFAULT 0,   -- unique members who paid this period
  total_transactions    INT           NOT NULL DEFAULT 0,   -- total payment count

  period_month          CHAR(7)       NOT NULL,             -- 'YYYY-MM' — NULL = all-time running
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, fund_type_id, period_month),

  CONSTRAINT collected_non_negative  CHECK (total_collected_kobo >= 0),
  CONSTRAINT paid_out_non_negative   CHECK (total_paid_out_kobo  >= 0),
  CONSTRAINT soft_lock_non_negative  CHECK (soft_lock_kobo       >= 0)
);

CREATE INDEX idx_fund_ledger_org_fund   ON fund_ledger(org_id, fund_type_id);
CREATE INDEX idx_fund_ledger_period     ON fund_ledger(org_id, period_month);

COMMENT ON TABLE fund_ledger IS 'Period-level running balance per fund — source of truth for available balance.';
COMMENT ON COLUMN fund_ledger.soft_lock_kobo IS 'Amount locked by a pending payout request — subtracted from available balance.';