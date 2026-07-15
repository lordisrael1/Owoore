-- 031_add_locked_period_to_payouts.sql
--
-- Records WHICH fund_ledger period row a payout's soft-lock was applied
-- to, so release/debit always target that exact row. Previously softLock
-- pinned "the latest period row" while releases used different selection
-- logic (or none at all in the expiry job) — a month rollover between
-- lock and release could free the reservation from the wrong row and
-- silently drift the available balance.
--
-- Nullable: payouts created before this migration have no recorded
-- period; release falls back to the legacy latest-locked-row behaviour.

ALTER TABLE payout_requests
  ADD COLUMN IF NOT EXISTS locked_period_month VARCHAR(7);

COMMENT ON COLUMN payout_requests.locked_period_month IS
  'fund_ledger.period_month the soft_lock was applied to (YYYY-MM); release/debit must target this row';
