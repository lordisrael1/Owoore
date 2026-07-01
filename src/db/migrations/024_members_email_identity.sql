-- 024_members_email_identity.sql
-- Termii SMS was unreliable for OTP delivery — switching member identity
-- and OTP delivery from phone to email (sent via Resend).

ALTER TABLE members ADD COLUMN email VARCHAR(255);

-- Safety net for any existing test rows — they won't be able to log in
-- until an admin updates their email, but this keeps the migration safe.
UPDATE members SET email = phone || '@placeholder.invalid' WHERE email IS NULL;

ALTER TABLE members ALTER COLUMN email SET NOT NULL;

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_org_id_phone_key;
ALTER TABLE members DROP COLUMN phone;

ALTER TABLE members ADD CONSTRAINT members_org_id_email_key UNIQUE (org_id, email);

DROP INDEX IF EXISTS idx_members_phone;
CREATE INDEX idx_members_email ON members(email);

COMMENT ON COLUMN members.email IS 'Member identity — OTP verification sent here via Resend.';
