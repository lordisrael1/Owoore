-- 020_drop_org_nomba_columns.sql
-- Architecture change: single shared Nomba sub-account (in env) instead of one per church.
-- Church balances are tracked in fund_ledger, not at the Nomba level.

ALTER TABLE organisations DROP COLUMN IF EXISTS nomba_sub_account_id;
ALTER TABLE organisations DROP COLUMN IF EXISTS nomba_account_ref;
