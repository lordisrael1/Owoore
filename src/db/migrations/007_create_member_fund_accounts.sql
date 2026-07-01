-- 007_create_member_fund_accounts.sql
-- THE CORE TABLE. This is the backbone of the entire product.
-- Every row maps one member + one fund type → one Nomba Virtual Account.
-- Created lazily: only when the member first taps "Pay [fund]".
--
-- account_reference is what we pass as accountRef to Nomba:
--   format: member_{member_id}_fund_{fund_type_id}
--   This is our stable key — we look up this table on EVERY webhook
--   to resolve: which member paid, which fund, which org.
--
-- nomba_va_number is the actual NUBAN shown to the member (e.g. 0123456789).
-- Once created, this number is permanent for RECURRING funds.
-- For CAMPAIGN funds it inherits the fund_type.expires_at.

CREATE TABLE member_fund_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  member_id         UUID          NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
  fund_type_id      UUID          NOT NULL REFERENCES fund_types(id) ON DELETE CASCADE,
  org_id            UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  -- Nomba VA fields
  nomba_va_number   VARCHAR(20)   NOT NULL,             -- NUBAN shown to member e.g. 0123456789
  nomba_va_id       VARCHAR(255),                       -- Nomba's internal VA ID (for GET calls)
  account_reference VARCHAR(255)  NOT NULL UNIQUE,      -- member_{id}_fund_{id} — our lookup key
  bank_name         VARCHAR(100)  NOT NULL DEFAULT 'Providus Bank', -- issuing bank for this VA

  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE(member_id, fund_type_id)                       -- one VA per member per fund
);

-- HOT PATH INDEX: every single webhook does this lookup
CREATE UNIQUE INDEX idx_mfa_account_reference ON member_fund_accounts(account_reference);

CREATE INDEX idx_mfa_member_id     ON member_fund_accounts(member_id);
CREATE INDEX idx_mfa_fund_type_id  ON member_fund_accounts(fund_type_id);
CREATE INDEX idx_mfa_org_id        ON member_fund_accounts(org_id);

COMMENT ON TABLE member_fund_accounts IS
  'Core VA mapping — member + fund type → Nomba NUBAN. One lookup resolves every inbound payment.';
COMMENT ON COLUMN member_fund_accounts.account_reference IS
  'Passed as accountRef to Nomba. Format: member_{uuid}_fund_{uuid}. Never changes.';
COMMENT ON COLUMN member_fund_accounts.nomba_va_number IS
  'The NUBAN the member copies into their banking app. Permanent for RECURRING funds.';