-- 002_create_admin_users.sql
-- Church admins and treasurers who manage the Owoore dashboard.
-- These are NOT members — they log in with email + password, not OTP.
-- One admin per org minimum (the person who registered the church).

CREATE TABLE admin_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            VARCHAR(255)  NOT NULL,
  email           VARCHAR(255)  NOT NULL,
  bcrypt_hash     TEXT          NOT NULL,                         -- never store plaintext
  role            VARCHAR(50)   NOT NULL DEFAULT 'ADMIN',         -- ADMIN | TREASURER
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, email)                                           -- email unique per org
);

CREATE INDEX idx_admin_users_org_id ON admin_users(org_id);
CREATE INDEX idx_admin_users_email  ON admin_users(email);

COMMENT ON TABLE admin_users IS 'Church admin and treasurer accounts — email+password auth';
COMMENT ON COLUMN admin_users.role IS 'ADMIN = full access | TREASURER = can initiate payouts';