-- 025_otp_tokens_email.sql
-- OTPs are now keyed by email instead of phone.

ALTER TABLE otp_tokens RENAME COLUMN phone TO email;
ALTER TABLE otp_tokens ALTER COLUMN email TYPE VARCHAR(255);

DROP INDEX IF EXISTS idx_otp_tokens_phone_active;
CREATE INDEX idx_otp_tokens_email_active
  ON otp_tokens(email, expires_at)
  WHERE used_at IS NULL;

COMMENT ON COLUMN otp_tokens.email IS 'Member email — OTP sent here via Resend.';
