-- 012_create_sweep_config.sql
-- Auto-sweep configuration per fund type.
-- When enabled, the sweep.job.ts cron checks this table nightly and fires
-- a Nomba transfer from the fund balance to the configured bank account.
-- sweep_day for WEEKLY = 0-6 (0=Sunday). For MONTHLY = 1-28 (day of month).
-- min_balance_kobo: don't sweep if available balance is below this floor.

CREATE TYPE sweep_schedule AS ENUM ('WEEKLY', 'MONTHLY', 'MANUAL');

CREATE TABLE sweep_configs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID            NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  fund_type_id        UUID            NOT NULL REFERENCES fund_types(id)    ON DELETE CASCADE UNIQUE,
  bank_account_id     UUID            NOT NULL REFERENCES org_bank_accounts(id),

  schedule            sweep_schedule  NOT NULL DEFAULT 'MANUAL',
  sweep_day           INT,                                   -- 0-6 for WEEKLY, 1-28 for MONTHLY
  min_balance_kobo    BIGINT          NOT NULL DEFAULT 0,    -- skip sweep if below this
  is_enabled          BOOLEAN         NOT NULL DEFAULT FALSE,
  last_swept_at       TIMESTAMPTZ,

  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT sweep_day_valid CHECK (
    sweep_day IS NULL
    OR (schedule = 'WEEKLY'  AND sweep_day BETWEEN 0 AND 6)
    OR (schedule = 'MONTHLY' AND sweep_day BETWEEN 1 AND 28)
  )
);

CREATE INDEX idx_sweep_configs_org_id ON sweep_configs(org_id);

COMMENT ON TABLE sweep_configs IS 'Auto-sweep schedule per fund — checked nightly by sweep.job.ts';
COMMENT ON COLUMN sweep_configs.sweep_day IS 'WEEKLY: 0=Sun,1=Mon…6=Sat. MONTHLY: 1-28 day of month.';