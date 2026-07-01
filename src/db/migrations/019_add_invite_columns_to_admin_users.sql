-- 019_add_invite_columns_to_admin_users.sql
-- Supports the treasurer invite flow:
--   Admin clicks "Invite Treasurer" → enters email → treasurer gets email link
--   Treasurer clicks link → sets password → account activates with role TREASURER
--
-- invite_token_hash stores a SHA-256 of the raw UUID token (same pattern as payout approvals).
-- bcrypt_hash is nullable now because invited users don't have a password until they accept.

ALTER TABLE admin_users
  ADD COLUMN invite_token_hash      TEXT,
  ADD COLUMN invite_token_expires_at TIMESTAMPTZ,
  ADD COLUMN invited_by             UUID REFERENCES admin_users(id);

-- Allow invited users to exist without a password until they accept
ALTER TABLE admin_users ALTER COLUMN bcrypt_hash DROP NOT NULL;

CREATE INDEX idx_admin_users_invite_token ON admin_users(invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

COMMENT ON COLUMN admin_users.invite_token_hash IS 'SHA-256 hash of the invite UUID — cleared on accept';
COMMENT ON COLUMN admin_users.invited_by IS 'The admin who sent the invite';
