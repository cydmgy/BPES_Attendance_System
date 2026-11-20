-- ============================================================
-- 005_cleanup.sql
-- Phase 6 (2/2): drop the legacy columns the session model replaced.
--
--   students.section              -> students.section_id -> sections.section_name
--   schedules.student_id          -> schedules are per section now (section_id)
--   subjects.room_id              -> the room is the section's home room (schedules.room_id)
--   subjects.instructor_id        -> schedules.teacher_id
--
-- Run only after the app no longer reads or writes them (nothing in backend/ or frontend/ does).
-- Idempotent. Aborts, changing nothing, if a student would lose their only section link.
-- NOTE: database/schema.sql still describes the starting point these migrations build on, so it keeps
-- these columns on purpose (migration 001 backfills sections from students.section).
-- ============================================================

BEGIN;

DO $$
BEGIN
  -- Only meaningful while the column still exists (re-running after the drop must be a no-op).
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'section') THEN
    IF EXISTS (SELECT 1 FROM public.students WHERE section_id IS NULL) THEN
      RAISE EXCEPTION '005_cleanup: some students have no section_id; link them to a section before dropping students.section';
    END IF;
  END IF;
END $$;

-- schedules: per-student legacy (the unique constraint and index go with the column anyway)
ALTER TABLE public.schedules DROP CONSTRAINT IF EXISTS uq_student_subject_schedule;
DROP INDEX IF EXISTS public.idx_schedules_student;
ALTER TABLE public.schedules DROP COLUMN IF EXISTS student_id;

-- subjects: room and teacher now come from schedules
ALTER TABLE public.subjects DROP COLUMN IF EXISTS room_id;
ALTER TABLE public.subjects DROP COLUMN IF EXISTS instructor_id;

-- students: sections.section_name is the single source for a student's section
ALTER TABLE public.students DROP COLUMN IF EXISTS section;

COMMIT;
