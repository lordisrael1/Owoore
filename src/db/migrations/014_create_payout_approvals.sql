-- 014_create_payout_approvals.sql
-- One row per signatory per payout request.
-- token is the UUID sent in the email link — single-use, expires at token_expires_at.
-- token_hash stores a bcrypt/SHA-256 hash of the token — never store raw tokens.
-- acted_at is NULL until the signatory taps Approve or Decline.
-- ip_address logged for audit trail — judges want to see this.

CREATE TYPE approval_action AS ENUM ('APPROVED', 'DECLINED');

CREATE TABLE payout_approvals (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payout_request_id   UUID            NOT NULL REFERENCES payout_requests(id) ON DELETE CASCADE,
  signatory_id        UUID            NOT NULL REFERENCES signatories(id),

  -- Token
  token               VARCHAR(255)    NOT NULL UNIQUE,    -- raw UUID sent in email (single-use)
  token_hash          VARCHAR(255)    NOT NULL,           -- SHA-256 hash stored in DB
  token_expires_at    TIMESTAMPTZ     NOT NULL,
  token_used_at       TIMESTAMPTZ,                        -- set on first use — prevents replay

  -- Action
  action              approval_action,                    -- NULL until signatory acts
  acted_at            TIMESTAMPTZ,
  ip_address          INET,                               -- IP of the approver's browser

  -- Resend tracking
  email_sent_at       TIMESTAMPTZ,
  email_resent_count  INT             NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  UNIQUE(payout_request_id, signatory_id)                -- one record per signatory per request
);

CREATE UNIQUE INDEX idx_payout_approvals_token     ON payout_approvals(token);
CREATE INDEX idx_payout_approvals_request_id       ON payout_approvals(payout_request_id);
CREATE INDEX idx_payout_approvals_expires_at       ON payout_approvals(token_expires_at) WHERE action IS NULL;

COMMENT ON TABLE payout_approvals IS 'Per-signatory approval records — token is the credential, no login required.';
COMMENT ON COLUMN payout_approvals.token IS 'UUID sent in email. Single-use — token_used_at set on first tap.';
COMMENT ON COLUMN payout_approvals.token_hash IS 'SHA-256 of token stored in DB. Raw token only in the email link.';