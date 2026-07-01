-- 001_create_organisations.sql
-- Every church that onboards Owoore is one row here.
-- slug is the public join code: owoore.ng/join/:slug
-- nomba_sub_account_id links to the Nomba sub-account provisioned on org creation.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE organisations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  VARCHAR(255)  NOT NULL,
  slug                  VARCHAR(100)  NOT NULL UNIQUE,   -- e.g. 'grace-bible-church'
  logo_url              TEXT,
  nomba_sub_account_id  VARCHAR(255)  NOT NULL UNIQUE,   -- Nomba sub-account ID
  nomba_account_ref     VARCHAR(255)  NOT NULL UNIQUE,   -- our stable accountRef passed to Nomba
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organisations_slug ON organisations(slug);

COMMENT ON TABLE organisations IS 'Each row is one church registered on Owoore';
COMMENT ON COLUMN organisations.slug IS 'URL-safe join code — shared with members via WhatsApp link';
COMMENT ON COLUMN organisations.nomba_sub_account_id IS 'Nomba sub-account where all member VA inflows settle';