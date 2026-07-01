-- 013_create_payout_requests.sql
-- One row per payout request initiated by a treasurer.
-- status is a strict state machine — see payout-state-machine.ts for valid transitions.
-- soft_lock is applied to fund_ledger when this request is created (PENDING)
-- and released when the request reaches a terminal state (TRANSFERRED/DECLINED/EXPIRED/FAILED/CANCELLED).
-- nomba_transfer_ref = the merchantTxRef we pass to Nomba — payout_{id} — idempotency key.

CREATE TYPE payout_status AS ENUM (
  'PENDING',       -- created, approval emails sent
  'PARTIAL',       -- some approvals received, quorum not yet reached
  'APPROVED',      -- quorum reached, transfer about to fire
  'TRANSFERRING',  -- Nomba API called, awaiting response
  'TRANSFERRED',   -- money moved, Nomba ref stored — terminal success
  'DECLINED',      -- any signatory declined — terminal failure
  'EXPIRED',       -- 72hrs passed with no quorum — terminal failure
  'FAILED',        -- Nomba transfer failed — funds unlocked, retry available
  'CANCELLED'      -- initiator cancelled before any approval — terminal
);

CREATE TABLE payout_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID            NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  fund_type_id        UUID            NOT NULL REFERENCES fund_types(id),
  bank_account_id     UUID            NOT NULL REFERENCES org_bank_accounts(id),
  initiated_by        UUID            NOT NULL REFERENCES admin_users(id),

  amount_kobo         BIGINT          NOT NULL CHECK (amount_kobo > 0),
  purpose             TEXT            NOT NULL,              -- "Roof contractor — Bello & Sons"
  status              payout_status   NOT NULL DEFAULT 'PENDING',

  -- Nomba transfer fields (populated on transfer attempt)
  nomba_transfer_ref  VARCHAR(255)    UNIQUE,                -- payout_{id} — idempotency key
  nomba_transfer_id   VARCHAR(255),                          -- Nomba's internal transfer ID
  transfer_error      TEXT,                                  -- Nomba error message on FAILED

  -- Tracking
  approvals_received  INT             NOT NULL DEFAULT 0,
  declined_by         UUID            REFERENCES signatories(id),
  executed_at         TIMESTAMPTZ,                           -- when transfer fired
  expires_at          TIMESTAMPTZ     NOT NULL,              -- auto_decline_hours from created_at

  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payout_requests_org_id      ON payout_requests(org_id);
CREATE INDEX idx_payout_requests_status      ON payout_requests(org_id, status);
CREATE INDEX idx_payout_requests_expires_at  ON payout_requests(expires_at) WHERE status IN ('PENDING', 'PARTIAL');

COMMENT ON TABLE payout_requests IS 'Treasury payout requests — strict state machine, immutable once TRANSFERRED.';
COMMENT ON COLUMN payout_requests.nomba_transfer_ref IS 'merchantTxRef for Nomba — payout_{uuid}. Idempotent: retrying FAILED uses same ref.';
COMMENT ON COLUMN payout_requests.expires_at IS 'Indexed for the hourly expiry.job.ts cron scan.';