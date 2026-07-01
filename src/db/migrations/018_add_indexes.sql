-- 018_add_indexes.sql
-- Performance indexes added after all tables exist.
-- Covers the most common query patterns in the application:
--   1. Webhook hot path: account_reference lookup (already unique on 007, confirmed here)
--   2. Dashboard queries: fund totals per period
--   3. Member giving history
--   4. Payout request list by status
--   5. Audit log queries by org + date range

-- ── Webhook hot path ─────────────────────────────────────────────────────
-- Already created as UNIQUE in 007, verify here for clarity
-- member_fund_accounts.account_reference — O(1) lookup on every inbound webhook

-- ── Dashboard aggregate queries ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_org_period_fund
  ON transactions(org_id, period_month, fund_type_id);

CREATE INDEX IF NOT EXISTS idx_anon_tx_org_period_fund
  ON anonymous_transactions(org_id, period_month, fund_type_id);

-- ── Member portal: giving history ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_member_created
  ON transactions(member_id, created_at DESC);

-- ── Member fund accounts: member portal VA list ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_mfa_member_active
  ON member_fund_accounts(member_id, is_active);

-- ── Payout list by org + status (admin dashboard) ────────────────────────
CREATE INDEX IF NOT EXISTS idx_payout_requests_org_created
  ON payout_requests(org_id, created_at DESC);

-- ── Audit log: org-scoped timeline ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_log_org_created
  ON audit_log(org_id, created_at DESC);

-- ── Fund ledger: all-time balance lookup ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fund_ledger_org_fund_period
  ON fund_ledger(org_id, fund_type_id, period_month);

-- ── Sweep job: find due sweeps ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sweep_configs_enabled
  ON sweep_configs(schedule, is_enabled)
  WHERE is_enabled = TRUE;

-- ── Expiry job: find pending requests past deadline ──────────────────────
CREATE INDEX IF NOT EXISTS idx_payout_requests_expiry_scan
  ON payout_requests(expires_at, status)
  WHERE status IN ('PENDING', 'PARTIAL');

COMMENT ON INDEX idx_transactions_org_period_fund IS 'Covers the main dashboard aggregate: SUM(amount_kobo) per fund per month.';
COMMENT ON INDEX idx_mfa_account_reference IS 'Hot path: every webhook does a single lookup here to resolve member + fund.';