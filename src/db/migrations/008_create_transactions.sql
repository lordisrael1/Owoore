-- 008_create_transactions.sql
-- One row per inbound payment on a member's dedicated VA.
-- Written by the webhook handler after HMAC verification and idempotency check.
-- payment_status is the reconciliation result:
--   EXACT       — received == expected amount (or no expected amount set)
--   UNDERPAYMENT — received < expected (deficit tracked in fund_ledger)
--   OVERPAYMENT  — received > expected (credit tracked in fund_ledger)
-- nomba_tx_ref is the unique idempotency key from Nomba's webhook payload.

CREATE TYPE payment_status AS ENUM ('EXACT', 'UNDERPAYMENT', 'OVERPAYMENT');

CREATE TABLE transactions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  member_fund_account_id  UUID          NOT NULL REFERENCES member_fund_accounts(id),
  member_id               UUID          NOT NULL REFERENCES members(id),
  fund_type_id            UUID          NOT NULL REFERENCES fund_types(id),
  org_id                  UUID          NOT NULL REFERENCES organisations(id),

  -- Amount fields — all in kobo
  amount_kobo             BIGINT        NOT NULL CHECK (amount_kobo > 0),
  expected_amt_kobo       BIGINT,                       -- snapshot of fund expected at time of payment
  variance_kobo           BIGINT        NOT NULL DEFAULT 0, -- positive = over, negative = under

  -- Reconciliation
  payment_status          payment_status NOT NULL DEFAULT 'EXACT',

  -- Nomba fields
  nomba_tx_ref            VARCHAR(255)  NOT NULL UNIQUE, -- idempotency key from webhook
  nomba_session_id        VARCHAR(255),                  -- Nomba's session reference
  sender_account          VARCHAR(20),                   -- sender's bank account (from webhook)
  sender_bank             VARCHAR(100),                  -- sender's bank name (from webhook)
  sender_name             VARCHAR(255),                  -- sender name (from webhook)
  narration               TEXT,                          -- transfer narration from bank rails

  -- Metadata
  period_month            CHAR(7)       NOT NULL,        -- '2026-06' — for period-level reporting
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_transactions_nomba_tx_ref  ON transactions(nomba_tx_ref);
CREATE INDEX idx_transactions_member_id            ON transactions(member_id);
CREATE INDEX idx_transactions_fund_type_id         ON transactions(fund_type_id);
CREATE INDEX idx_transactions_org_id               ON transactions(org_id);
CREATE INDEX idx_transactions_period               ON transactions(org_id, period_month);
CREATE INDEX idx_transactions_created_at           ON transactions(created_at);

COMMENT ON TABLE transactions IS 'One row per inbound member payment. Written atomically by webhook handler.';
COMMENT ON COLUMN transactions.nomba_tx_ref IS 'Nomba requestId used as idempotency key — unique constraint prevents double-credit.';
COMMENT ON COLUMN transactions.variance_kobo IS 'Positive = overpayment credit. Negative = underpayment deficit.';
COMMENT ON COLUMN transactions.period_month IS 'YYYY-MM snapshot for monthly reporting without date arithmetic.';