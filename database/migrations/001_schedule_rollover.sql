-- ============================================================
-- 001_schedule_rollover.sql
-- Phase 1: section-based schedules, teacher-tap sessions, daily presence.
-- Idempotent: safe to run more than once. Apply after database/schema.sql.
--
-- Conventions kept from schema.sql:
--   * every PK is UUID DEFAULT gen_random_uuid()
--   * status values are lowercase
--   * timestamps are TIMESTAMPTZ (stored UTC); calendar dates are Asia/Manila
--   * spec "users" = existing students + instructors; teacher_id -> instructors(id)
-- ============================================================

BEGIN;

-- Needed for EXCLUDE constraints mixing "=" on uuid/varchar with "&&" on ranges.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ------------------------------------------------------------
-- 1. SECTIONS (new): one permanent homeroom per student block
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_name  VARCHAR(50) NOT NULL UNIQUE,
  home_room_id  UUID REFERENCES rooms(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Backfill from the free-text students.section column.
INSERT INTO sections (section_name)
SELECT DISTINCT trim(section)
FROM students
WHERE section IS NOT NULL AND trim(section) <> ''
ON CONFLICT (section_name) DO NOTHING;

-- ------------------------------------------------------------
-- 2. STUDENTS: link to sections (old "section" text kept until cleanup migration)
-- ------------------------------------------------------------
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES sections(id) ON DELETE SET NULL;

UPDATE students s
SET section_id = sec.id
FROM sections sec
WHERE s.section_id IS NULL
  AND trim(s.section) = sec.section_name;

-- ------------------------------------------------------------
-- 3. INSTRUCTORS: own RFID card so teachers can tap the same reader
-- ------------------------------------------------------------
ALTER TABLE instructors
  ADD COLUMN IF NOT EXISTS rfid_uid VARCHAR(50) UNIQUE;

-- ------------------------------------------------------------
-- 4. ROOMS: map the installed ESP32 node to its room
-- ------------------------------------------------------------
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS device_id VARCHAR(50) UNIQUE;

-- ------------------------------------------------------------
-- 5. SCHEDULES: per-student -> per-section master timetable (altered in place)
-- ------------------------------------------------------------
ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS room_id    UUID REFERENCES rooms(id)       ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES sections(id)    ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES instructors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status     VARCHAR(20) NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'archived'));

-- Legacy per-student column; dropped in the cleanup migration.
ALTER TABLE schedules ALTER COLUMN student_id DROP NOT NULL;

-- New rows must be fully anchored. Fails loudly if legacy rows exist (there were 0 at planning time).
ALTER TABLE schedules ALTER COLUMN room_id    SET NOT NULL;
ALTER TABLE schedules ALTER COLUMN section_id SET NOT NULL;
ALTER TABLE schedules ALTER COLUMN subject_id SET NOT NULL;

DO $$
BEGIN
  -- int4range() raises an error when lower > upper, so enforce ordering first.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'chk_schedules_time_order'
                   AND conrelid = 'public.schedules'::regclass) THEN
    ALTER TABLE schedules
      ADD CONSTRAINT chk_schedules_time_order CHECK (end_time > start_time);
  END IF;

  -- Default int4range bounds are [) so back-to-back periods (08:00-09:00, 09:00-10:00) do not collide.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'no_room_time_overlap'
                   AND conrelid = 'public.schedules'::regclass) THEN
    ALTER TABLE schedules
      ADD CONSTRAINT no_room_time_overlap
      EXCLUDE USING gist (
        room_id WITH =,
        day_of_week WITH =,
        int4range(EXTRACT(EPOCH FROM start_time)::int,
                  EXTRACT(EPOCH FROM end_time)::int) WITH &&
      ) WHERE (status = 'active');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'no_teacher_double_booking'
                   AND conrelid = 'public.schedules'::regclass) THEN
    ALTER TABLE schedules
      ADD CONSTRAINT no_teacher_double_booking
      EXCLUDE USING gist (
        teacher_id WITH =,
        day_of_week WITH =,
        int4range(EXTRACT(EPOCH FROM start_time)::int,
                  EXTRACT(EPOCH FROM end_time)::int) WITH &&
      ) WHERE (status = 'active');
  END IF;

  -- Not in the spec: a section cannot sit two classes at once.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'no_section_overlap'
                   AND conrelid = 'public.schedules'::regclass) THEN
    ALTER TABLE schedules
      ADD CONSTRAINT no_section_overlap
      EXCLUDE USING gist (
        section_id WITH =,
        day_of_week WITH =,
        int4range(EXTRACT(EPOCH FROM start_time)::int,
                  EXTRACT(EPOCH FROM end_time)::int) WITH &&
      ) WHERE (status = 'active');
  END IF;
END $$;

-- ------------------------------------------------------------
-- 6. SCHEDULE_CO_TEACHERS (new): secondary teachers allowed to open a session
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_co_teachers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  UUID NOT NULL REFERENCES schedules(id)   ON DELETE CASCADE,
  teacher_id   UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_schedule_co_teacher UNIQUE (schedule_id, teacher_id)
);

-- ------------------------------------------------------------
-- 7. SCHEDULE_OVERRIDES (new): one-day substitute without touching the timetable
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id     UUID NOT NULL REFERENCES schedules(id)   ON DELETE CASCADE,
  override_date   DATE NOT NULL,
  sub_teacher_id  UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_schedule_override UNIQUE (schedule_id, override_date)
);

-- ------------------------------------------------------------
-- 8. DAILY_PRESENCE (new): the once-a-day morning check-in
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_presence (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_id       UUID REFERENCES sections(id) ON DELETE SET NULL,
  attendance_date  DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::date),
  morning_time_in  TIMESTAMPTZ DEFAULT now(),
  is_present       BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_daily_presence UNIQUE (student_id, attendance_date)
);

-- ------------------------------------------------------------
-- 9. CLASS_SESSIONS (new): one execution record per scheduled period per day
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: archive schedules instead of deleting them, so session history survives.
  schedule_id        UUID NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
  session_date       DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::date),
  actual_teacher_id  UUID REFERENCES instructors(id) ON DELETE SET NULL,
  teacher_time_in    TIMESTAMPTZ,
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'ongoing', 'substituted', 'no_teacher', 'closed')),
  created_at         TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_class_session UNIQUE (schedule_id, session_date)
);

-- ------------------------------------------------------------
-- 10. ATTENDANCE_LOGS: link rows to a session ("timestamp" serves as time_in)
-- ------------------------------------------------------------
ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES class_sessions(id) ON DELETE SET NULL;

-- One row per student per session; lets bulk clones use ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_session_student
  ON attendance_logs (session_id, student_id)
  WHERE session_id IS NOT NULL;

-- Day grouping must follow Manila dates, not UTC dates.
DROP INDEX IF EXISTS idx_attendance_date;
CREATE INDEX IF NOT EXISTS idx_attendance_manila_date
  ON attendance_logs ((("timestamp" AT TIME ZONE 'Asia/Manila')::date));

-- ------------------------------------------------------------
-- 11. INDEXES on new FK / lookup columns
-- (leading columns of the UNIQUE constraints above are already indexed)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_students_section_id     ON students (section_id);
CREATE INDEX IF NOT EXISTS idx_sections_home_room      ON sections (home_room_id);
CREATE INDEX IF NOT EXISTS idx_schedules_room_day      ON schedules (room_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_schedules_teacher_day   ON schedules (teacher_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_schedules_section_day   ON schedules (section_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_co_teachers_teacher     ON schedule_co_teachers (teacher_id);
CREATE INDEX IF NOT EXISTS idx_overrides_sub_teacher   ON schedule_overrides (sub_teacher_id);
CREATE INDEX IF NOT EXISTS idx_overrides_date          ON schedule_overrides (override_date);
CREATE INDEX IF NOT EXISTS idx_presence_section_date   ON daily_presence (section_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_sessions_date_status    ON class_sessions (session_date, status);
CREATE INDEX IF NOT EXISTS idx_sessions_actual_teacher ON class_sessions (actual_teacher_id);

-- ------------------------------------------------------------
-- 12. RLS: same posture as existing tables (enabled, no policies => service role only)
-- ------------------------------------------------------------
ALTER TABLE sections             ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_co_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_overrides   ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_presence       ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_sessions       ENABLE ROW LEVEL SECURITY;

COMMIT;
