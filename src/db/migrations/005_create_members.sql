-- 005_create_members.sql
-- Church members who self-onboard via the join link.
-- Phone number is the permanent identity anchor — no password, no email required.
-- A member can belong to only one org (one person, one church, one phone).
-- member_code is a human-readable ID shown on the dashboard: CHR-00142.

CREATE TABLE members (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID          NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  phone         VARCHAR(20)   NOT NULL,               -- normalised to +234 format
  display_name  VARCHAR(255)  NOT NULL,               -- set by member on first join
  member_code   VARCHAR(20)   NOT NULL,               -- CHR-00142 — auto-generated
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  joined_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, phone),                              -- one member per phone per church
  UNIQUE(org_id, member_code)
);

CREATE INDEX idx_members_org_id ON members(org_id);
CREATE INDEX idx_members_phone  ON members(phone);

COMMENT ON TABLE members IS 'Church members — phone = identity, OTP = auth, no password';
COMMENT ON COLUMN members.phone IS 'Always stored in +234 international format';
COMMENT ON COLUMN members.member_code IS 'Human-readable ID shown on admin dashboard (e.g. CHR-00142)';