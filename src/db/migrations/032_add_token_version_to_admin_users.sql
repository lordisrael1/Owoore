-- 032_add_token_version_to_admin_users.sql
--
-- Admin JWTs are fully stateless (jwt.verify only checks signature +
-- expiry, no DB lookup) with a 1-day default expiry. That means the
-- existing "revoke a teammate's access" feature (admin_users.is_active)
-- does NOT actually invalidate their current session — a deactivated or
-- fired admin's token keeps working for up to 24h regardless, since
-- nothing in the request path ever reads is_active.
--
-- token_version closes that gap without a sessions table: it's embedded
-- in the JWT at sign time, and checked (Redis-cached, ~30s TTL) on every
-- admin request. Bumping it invalidates every token issued before that
-- instant, everywhere, immediately — used by both self-service logout
-- and by setActive(false) revoking a teammate.

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN admin_users.token_version IS
  'Bumped to invalidate every previously-issued JWT for this admin (logout-everywhere / revoke access). Checked against the version embedded in the token at auth time.';
