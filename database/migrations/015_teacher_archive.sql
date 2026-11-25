-- 015_teacher_archive: a teacher with class history is archived instead of deleted. Apply by hand BEFORE deploying (Render does not run migrations):
-- until then listing and logging in teachers, the scan lookup and the dashboard teacher count fail. Nullable: NULL = active. The card and email stay reserved. Safe to re-run.
ALTER TABLE instructors ADD COLUMN IF NOT EXISTS archived_at timestamptz;
