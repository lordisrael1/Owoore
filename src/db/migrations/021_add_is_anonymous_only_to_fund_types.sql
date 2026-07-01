-- 021_add_is_anonymous_only_to_fund_types.sql
-- Marks the system-created "Anonymous Giving" fund so it can be excluded
-- from member fund-selection and admin fund-management lists, while still
-- counting toward the org's balance on the dashboard.

ALTER TABLE fund_types ADD COLUMN is_anonymous_only BOOLEAN NOT NULL DEFAULT FALSE;
