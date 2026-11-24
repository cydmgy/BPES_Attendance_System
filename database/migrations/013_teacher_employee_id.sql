-- 013_teacher_employee_id: a teacher's own ID number (typed at registration). The default password is
-- surname + the last 4 letters/digits of it. Apply by hand BEFORE deploying (Render does not run migrations):
-- until then listing, creating and editing teachers fail. Nullable, so existing teachers keep working
-- (their password is unchanged); unique when set. Safe to re-run.
ALTER TABLE instructors ADD COLUMN IF NOT EXISTS employee_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_instructors_employee_id ON instructors (lower(employee_id)) WHERE employee_id IS NOT NULL;
