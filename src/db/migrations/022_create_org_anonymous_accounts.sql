-- 022_create_org_anonymous_accounts.sql
-- Dedicated table for the single org-level VA used for anonymous giving.
-- Previously this was hacked into member_fund_accounts using org_id as a
-- sentinel member_id, which violates the table's member_id FK constraint.
-- An org is not a member — this gets its own table.
--
-- One row per org: the single shared "Anonymous Giving" VA.
-- org_id is kept here (not just inferred via fund_type_id) so every row is
-- directly traceable to the owning church without an extra join.
--
-- Money accounting: inflows to this VA credit fund_ledger keyed on
-- (org_id, fund_type_id) — same mechanism as every other fund. The org's
-- total balance (dashboard summary) is the SUM of fund_ledger across ALL
-- of its fund_types, which already includes the anonymous-only fund row.
-- No separate balance tracking needed here — this table only stores the
-- VA identity, never a balance.

CREATE TABLE org_anonymous_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID          NOT NULL UNIQUE REFERENCES organisations(id) ON DELETE CASCADE,
  fund_type_id      UUID          NOT NULL REFERENCES fund_types(id) ON DELETE CASCADE,

  nomba_va_number   VARCHAR(20)   NOT NULL,
  nomba_va_id       VARCHAR(255),
  account_reference VARCHAR(255)  NOT NULL UNIQUE,      -- anon_{org_id}
  bank_name         VARCHAR(100)  NOT NULL DEFAULT 'Providus Bank',

  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_oaa_account_reference ON org_anonymous_accounts(account_reference);
CREATE INDEX idx_oaa_org_id ON org_anonymous_accounts(org_id);

COMMENT ON TABLE org_anonymous_accounts IS
  'One shared VA per org for anonymous giving — separate from member_fund_accounts since it is not tied to a member. Balance lives in fund_ledger, not here.';
