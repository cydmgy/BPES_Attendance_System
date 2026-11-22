-- 011_audit_and_accounts: audit log, editable admin account, forced student PIN change.
-- Apply by hand (Render does not run migrations), before deploying the code that uses it. Safe to re-run.
--
--   audit_log                    one row per recorded action. actor_id is text (the admin has no uuid).
--                                RLS on, no policies: only the service-role key reads or writes
--   admin_settings               single row (id is always true): display name and optional password hash
--                                that overrides ADMIN_PASSWORD once set. RLS on, no policies
--   students.must_change_password  true after an admin sets or resets a PIN, cleared when the student changes it
--
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id TEXT,
  actor_role TEXT NOT NULL,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS admin_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  display_name TEXT NOT NULL DEFAULT 'Administrator',
  password_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;
INSERT INTO admin_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE students ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
