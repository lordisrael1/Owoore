-- 015_create_otp_tokens.sql
-- OTP records for member phone verification.
-- Primary store is Redis (TTL 10 min) for speed.
-- DB store is secondary — used for audit log and rate-limit enforcement across instances.
-- attempts tracks failed verifications — lock after 5 wrong attempts.
-- used_at prevents OTP reuse even if Redis TTL hasn't expired.

CREATE TABLE otp_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       VARCHAR(20)   NOT NULL,         -- +234 format
  code        VARCHAR(6)    NOT NULL,          -- 4 or 6 digit OTP
  attempts    INT           NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,                     -- set on successful verify
  expires_at  TIMESTAMPTZ   NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Only one active OTP per phone at a time
CREATE INDEX idx_otp_tokens_phone_active
  ON otp_tokens(phone, expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE otp_tokens IS 'Member OTP records — Redis is primary, DB is audit + cross-instance rate limit.';
COMMENT ON COLUMN otp_tokens.attempts IS 'Failed verify attempts — lock after 5 to prevent brute-force.';