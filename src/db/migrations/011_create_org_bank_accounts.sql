-- 011_create_org_bank_accounts.sql
-- The church's real bank accounts that money sweeps OUT to.
-- fund_type_id = NULL means this is the general church account (catch-all).
-- fund_type_id set = this fund sweeps to a specific account (building project acct, welfare acct).
-- is_verified: set to true after a successful /transfers/bank/lookup name confirmation.
-- is_default: the fallback account if no fund-specific account is configured.

CREATE TABLE org_bank_accounts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  fund_type_id    UUID          REFERENCES fund_types(id) ON DELETE SET NULL, -- NULL = general
  label           VARCHAR(255)  NOT NULL,               -- 'Main Church Account' | 'Building Project'
  bank_code       VARCHAR(10)   NOT NULL,               -- CBN bank code e.g. '058' for GTBank
  bank_name       VARCHAR(100)  NOT NULL,               -- display name e.g. 'GTBank'
  account_number  VARCHAR(20)   NOT NULL,
  account_name    VARCHAR(255)  NOT NULL,               -- verified name from /transfers/bank/lookup
  is_verified     BOOLEAN       NOT NULL DEFAULT FALSE, -- true after name-lookup confirmation
  is_default      BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_bank_accounts_org_id       ON org_bank_accounts(org_id);
CREATE INDEX idx_org_bank_accounts_fund_type_id ON org_bank_accounts(fund_type_id);

COMMENT ON TABLE org_bank_accounts IS 'Church destination bank accounts for payout transfers.';
COMMENT ON COLUMN org_bank_accounts.fund_type_id IS 'NULL = general account. Set = fund-specific destination (e.g. building project account).';
COMMENT ON COLUMN org_bank_accounts.is_verified IS 'Set TRUE only after /transfers/bank/lookup confirms the account name matches.';