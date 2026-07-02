-- 027_add_is_verified_to_admin_users.sql
-- Closes a gap in the self-registration flow (POST /orgs): a church admin
-- could set a password for any email address with zero proof they actually
-- own it. New self-registered admins now must verify their email via OTP
-- (POST /auth/send-otp + POST /auth/admin/verify-email) before logging in.
--
-- Invited admins/treasurers (POST /admin-users/invite) are exempt — clicking
-- the unique tokenized invite link sent to their inbox already proves email
-- ownership, so acceptInvite() sets is_verified = TRUE directly.
--
-- Existing rows are backfilled TRUE so no admin who can already log in today
-- gets locked out by this change.

ALTER TABLE admin_users ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE admin_users SET is_verified = TRUE WHERE is_active = TRUE;

COMMENT ON COLUMN admin_users.is_verified IS 'TRUE once the admin has confirmed ownership of their email — via OTP (self-registration) or by accepting an emailed invite link (invited users).';
