-- 026_create_member_refresh_tokens.sql
-- Long-lived refresh tokens for church members, decoupled from the short-lived
-- access token issued at OTP verification.
--
-- Fixes a bug where POST /auth/refresh required the access token itself to
-- still be valid (jwt.verify enforces exp on both the route middleware and
-- the refresh handler) — making it impossible to refresh a session once it
-- had actually expired.
--
-- token_hash: SHA-256 of an opaque random token (crypto.randomBytes), same
-- pattern as payout_approvals.token_hash. The raw token is returned to the
-- client once and never stored.
-- Rotating: every successful refresh revokes this row (revoked_at) and
-- issues a new row + new raw token. A revoked token being reused again is
-- a theft signal — the auth service revokes all of that member's tokens
-- when it sees this.

CREATE TABLE member_refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  member_id   UUID          NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255)  NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ   NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_member_refresh_tokens_hash ON member_refresh_tokens(token_hash);
CREATE INDEX idx_member_refresh_tokens_member_active
  ON member_refresh_tokens(member_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE member_refresh_tokens IS 'Long-lived, DB-tracked refresh tokens for members — rotated on every use, independent of access token expiry.';
COMMENT ON COLUMN member_refresh_tokens.token_hash IS 'SHA-256 of the raw token. Raw token is only ever sent to the client once.';
COMMENT ON COLUMN member_refresh_tokens.revoked_at IS 'Set when rotated (used) or revoked for theft-detection. NULL = still active.';
