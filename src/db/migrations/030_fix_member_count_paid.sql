-- 030_fix_member_count_paid.sql
-- member_count_paid is documented as "unique members who paid this period"
-- but creditLedger incremented it on EVERY inflow, so a member paying twice
-- counted as two givers — and anonymous/shared-VA inflows (which have no
-- member identity at all) were counted too.
--
-- The write path is fixed in ledger.service.ts (only a member's first
-- payment to a fund in a period increments the counter; anonymous inflows
-- never do). This backfill recomputes the counter for all existing rows
-- from the transactions table, which is the source of truth for
-- member-attributed payments. Rows for shared/anonymous funds have no rows
-- in transactions and correctly land on 0.

UPDATE fund_ledger fl
SET member_count_paid = (
  SELECT COUNT(DISTINCT t.member_id)::INT
  FROM transactions t
  WHERE t.fund_type_id = fl.fund_type_id
    AND t.period_month = fl.period_month
);
