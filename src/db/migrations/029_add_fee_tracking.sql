-- 029_add_fee_tracking.sql
-- Nomba charges a fee on BOTH legs of the money path:
--   inbound VA payment  → transaction.fee (e.g. ₦10) — wallet credits amount − fee
--   outbound transfer   → transaction.fee (e.g. ₦20) — wallet debits  amount + fee
--
-- The ledger previously credited gross and debited net, so available
-- balance drifted above the real Nomba wallet by every fee ever charged,
-- and full-balance payouts could fail with insufficient funds.
--
-- Member attribution stays GROSS (a member who sent ₦150 gave ₦150);
-- fees are tracked separately and subtracted from the available balance:
--   available = collected − fees − paid_out − soft_lock

ALTER TABLE transactions           ADD COLUMN fee_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE anonymous_transactions ADD COLUMN fee_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payout_requests        ADD COLUMN fee_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE fund_ledger            ADD COLUMN total_fees_kobo BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN transactions.fee_kobo IS
  'Nomba inbound fee — transaction.fee from the payment_success webhook. Member gave amount_kobo; wallet received amount_kobo − fee_kobo.';
COMMENT ON COLUMN payout_requests.fee_kobo IS
  'Nomba transfer fee — stamped at settlement from the payout_success webhook. Wallet was debited amount_kobo + fee_kobo.';
COMMENT ON COLUMN fund_ledger.total_fees_kobo IS
  'All Nomba fees (inbound + outbound) for this fund/period — subtracted from available balance.';

-- ── Backfill: every webhook payload was stored raw in webhook_log ────────
-- Inbound fees (member VAs)
UPDATE transactions t
SET fee_kobo = ROUND((wl.raw_payload->'data'->'transaction'->>'fee')::NUMERIC * 100)
FROM webhook_log wl
WHERE wl.event_type = 'payment_success'
  AND wl.raw_payload->'data'->'transaction'->>'transactionId' = t.nomba_tx_ref
  AND (wl.raw_payload->'data'->'transaction'->>'fee') ~ '^[0-9.]+$';

-- Inbound fees (shared/anonymous VAs)
UPDATE anonymous_transactions t
SET fee_kobo = ROUND((wl.raw_payload->'data'->'transaction'->>'fee')::NUMERIC * 100)
FROM webhook_log wl
WHERE wl.event_type = 'payment_success'
  AND wl.raw_payload->'data'->'transaction'->>'transactionId' = t.nomba_tx_ref
  AND (wl.raw_payload->'data'->'transaction'->>'fee') ~ '^[0-9.]+$';

-- Outbound transfer fees
UPDATE payout_requests pr
SET fee_kobo = ROUND((wl.raw_payload->'data'->'transaction'->>'fee')::NUMERIC * 100)
FROM webhook_log wl
WHERE wl.event_type = 'payout_success'
  AND wl.raw_payload->'data'->'transaction'->>'merchantTxRef' = pr.nomba_transfer_ref
  AND (wl.raw_payload->'data'->'transaction'->>'fee') ~ '^[0-9.]+$';

-- Recompute per-period fee totals into the ledger
UPDATE fund_ledger fl
SET total_fees_kobo = f.fees
FROM (
  SELECT org_id, fund_type_id, period_month, SUM(fees)::BIGINT AS fees
  FROM (
    SELECT org_id, fund_type_id, period_month, SUM(fee_kobo) AS fees
    FROM transactions GROUP BY 1, 2, 3
    UNION ALL
    SELECT org_id, fund_type_id, period_month, SUM(fee_kobo)
    FROM anonymous_transactions GROUP BY 1, 2, 3
    UNION ALL
    SELECT org_id, fund_type_id, TO_CHAR(executed_at, 'YYYY-MM'), SUM(fee_kobo)
    FROM payout_requests
    WHERE status = 'TRANSFERRED' AND executed_at IS NOT NULL
    GROUP BY 1, 2, 3
  ) u
  GROUP BY 1, 2, 3
) f
WHERE fl.org_id = f.org_id
  AND fl.fund_type_id = f.fund_type_id
  AND fl.period_month = f.period_month;
