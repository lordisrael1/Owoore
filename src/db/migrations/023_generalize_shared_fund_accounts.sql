-- 023_generalize_shared_fund_accounts.sql
-- Generalizes the org-level VA mechanism so ANY fund can be marked "shared"
-- (one VA for the whole org, no per-member tracking) — not just the public
-- Anonymous Giving fund. Offering-type funds use this too.
--
-- is_shared_va: fund uses one org-wide VA. No member_fund_accounts row is
--   ever created for it; inflows are recorded in anonymous_transactions
--   (org + fund, no member attribution).
-- is_anonymous_only: fund is additionally exposed on the public /give page
--   with no auth required. Always implies is_shared_va = TRUE.

ALTER TABLE fund_types ADD COLUMN is_shared_va BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE fund_types SET is_shared_va = TRUE WHERE is_anonymous_only = TRUE;

ALTER TABLE org_anonymous_accounts RENAME TO org_shared_fund_accounts;

ALTER TABLE org_shared_fund_accounts
  DROP CONSTRAINT IF EXISTS org_anonymous_accounts_org_id_key;

ALTER TABLE org_shared_fund_accounts
  ADD CONSTRAINT org_shared_fund_accounts_org_id_fund_type_id_key UNIQUE (org_id, fund_type_id);

ALTER INDEX IF EXISTS idx_oaa_account_reference RENAME TO idx_osfa_account_reference;
ALTER INDEX IF EXISTS idx_oaa_org_id RENAME TO idx_osfa_org_id;

COMMENT ON TABLE org_shared_fund_accounts IS
  'One VA per (org, fund) for any fund marked is_shared_va — no per-member tracking. Covers the public Anonymous Giving fund and member-portal shared funds like Offering.';
