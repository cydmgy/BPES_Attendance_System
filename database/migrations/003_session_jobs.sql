-- ============================================================
-- 003_session_jobs.sql
-- Phase 4 (part 1): the functions the timed jobs run. Idempotent (CREATE OR REPLACE).
-- Every function takes an optional p_now (default now()) so tests can run them at any time.
-- All dates / weekdays / clock times are Asia/Manila.
--
--   roll_in_students(session, when)     shared clone logic (leave -> 'excused', checked-in -> 'present')
--   open_class_session(...)             replaced to use roll_in_students (same behaviour as 002)
--   generate_daily_sessions()           'pending' sessions for today's active periods not yet ended
--   mark_no_teacher_sessions()          pending past start + grace -> 'no_teacher', present students rolled in
--   close_ended_sessions()              past end -> 'closed'; auto-absent only for ongoing/substituted
-- ============================================================

BEGIN;

-- Rolls a session's section students into attendance_logs. Safe to repeat: existing rows are kept.
-- Approved leave (all-day, or for this subject) wins over presence, so a student on leave who tapped
-- in this morning is still 'excused'.
CREATE OR REPLACE FUNCTION public.roll_in_students(p_session_id uuid, p_when timestamptz)
RETURNS TABLE (o_cloned integer, o_excused integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_sess    record;
  v_cloned  integer := 0;
  v_excused integer := 0;
BEGIN
  SELECT cs.id, cs.session_date, s.section_id, s.subject_id, s.room_id
    INTO v_sess
    FROM public.class_sessions cs
    JOIN public.schedules s ON s.id = cs.schedule_id
   WHERE cs.id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'roll_in_students: session % not found', p_session_id USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.attendance_logs (session_id, student_id, room_id, rfid_uid, status, device_id, "timestamp")
  SELECT v_sess.id, st.id, v_sess.room_id, st.rfid_uid, 'excused', 'SYSTEM', p_when
    FROM public.students st
   WHERE st.section_id = v_sess.section_id
     AND EXISTS (
           SELECT 1 FROM public.leave_requests lr
            WHERE lr.student_id = st.id
              AND lr.leave_date = v_sess.session_date
              AND lr.status = 'approved'
              AND (lr.subject_id IS NULL OR lr.subject_id = v_sess.subject_id))
  ON CONFLICT (session_id, student_id) WHERE session_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_excused = ROW_COUNT;

  INSERT INTO public.attendance_logs (session_id, student_id, room_id, rfid_uid, status, device_id, "timestamp")
  SELECT v_sess.id, st.id, v_sess.room_id, st.rfid_uid, 'present', 'SYSTEM', p_when
    FROM public.daily_presence dp
    JOIN public.students st ON st.id = dp.student_id
   WHERE dp.attendance_date = v_sess.session_date
     AND dp.is_present
     AND st.section_id = v_sess.section_id
  ON CONFLICT (session_id, student_id) WHERE session_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_cloned = ROW_COUNT;

  RETURN QUERY SELECT v_cloned, v_excused;
END;
$$;

-- Same contract as in 002, now built on roll_in_students.
CREATE OR REPLACE FUNCTION public.open_class_session(
  p_schedule_id uuid,
  p_teacher_id  uuid,
  p_tap_time    timestamptz,
  p_status      text
)
RETURNS TABLE (
  o_session_id      uuid,
  o_status          text,
  o_teacher_time_in timestamptz,
  o_opened          boolean,
  o_cloned          integer,
  o_excused         integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_date    date := (p_tap_time AT TIME ZONE 'Asia/Manila')::date;
  v_session public.class_sessions%ROWTYPE;
  v_opened  boolean := false;
  v_cloned  integer := 0;
  v_excused integer := 0;
BEGIN
  IF p_status NOT IN ('ongoing', 'substituted') THEN
    RAISE EXCEPTION 'open_class_session: invalid status %', p_status USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schedules s WHERE s.id = p_schedule_id) THEN
    RAISE EXCEPTION 'open_class_session: schedule % not found', p_schedule_id USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.class_sessions (schedule_id, session_date)
  VALUES (p_schedule_id, v_date)
  ON CONFLICT (schedule_id, session_date) DO NOTHING;

  SELECT * INTO v_session
    FROM public.class_sessions cs
   WHERE cs.schedule_id = p_schedule_id AND cs.session_date = v_date
     FOR UPDATE;

  IF v_session.status IN ('pending', 'no_teacher') THEN
    UPDATE public.class_sessions cs
       SET status = p_status,
           actual_teacher_id = p_teacher_id,
           teacher_time_in = p_tap_time
     WHERE cs.id = v_session.id
    RETURNING * INTO v_session;
    v_opened := true;
    SELECT r.o_cloned, r.o_excused INTO v_cloned, v_excused
      FROM public.roll_in_students(v_session.id, p_tap_time) r;
  END IF;

  RETURN QUERY
  SELECT v_session.id, v_session.status::text, v_session.teacher_time_in, v_opened, v_cloned, v_excused;
END;
$$;

-- Today's active periods that have not ended yet get a 'pending' session, so portals can show "upcoming".
-- A period added after it ended gets none (nothing to take attendance for).
CREATE OR REPLACE FUNCTION public.generate_daily_sessions(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_local timestamp := p_now AT TIME ZONE 'Asia/Manila';
  v_day   text := (ARRAY['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])
                  [extract(dow FROM p_now AT TIME ZONE 'Asia/Manila')::int + 1];
  v_n     integer;
BEGIN
  INSERT INTO public.class_sessions (schedule_id, session_date)
  SELECT s.id, v_local::date
    FROM public.schedules s
   WHERE s.status = 'active'
     AND s.day_of_week = v_day
     AND v_local::time < s.end_time
  ON CONFLICT (schedule_id, session_date) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- A 'pending' session whose teacher has not tapped p_grace_minutes after the period started becomes
-- 'no_teacher'; students already checked in are rolled in as present (excused if on leave).
-- Rows are skipped when locked, so a teacher tapping at the same moment always wins.
CREATE OR REPLACE FUNCTION public.mark_no_teacher_sessions(p_now timestamptz DEFAULT now(), p_grace_minutes integer DEFAULT 15)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_local timestamp := p_now AT TIME ZONE 'Asia/Manila';
  v_rec   record;
  v_n     integer := 0;
BEGIN
  FOR v_rec IN
    SELECT cs.id, ((cs.session_date + s.start_time) AT TIME ZONE 'Asia/Manila') AS starts_at
      FROM public.class_sessions cs
      JOIN public.schedules s ON s.id = cs.schedule_id
     WHERE cs.status = 'pending'
       AND (cs.session_date + s.start_time) + make_interval(mins => p_grace_minutes) <= v_local
     ORDER BY cs.id
       FOR UPDATE OF cs SKIP LOCKED
  LOOP
    UPDATE public.class_sessions cs SET status = 'no_teacher' WHERE cs.id = v_rec.id AND cs.status = 'pending';
    PERFORM public.roll_in_students(v_rec.id, v_rec.starts_at);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Once a period has ended its session is closed.
--   ongoing / substituted : section students with no log get 'absent' (stamped at the period's end);
--   no_teacher            : closed with no auto-absent (the school could not take attendance);
--   pending (never marked): treated as no_teacher.
CREATE OR REPLACE FUNCTION public.close_ended_sessions(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_local timestamp := p_now AT TIME ZONE 'Asia/Manila';
  v_rec   record;
  v_n     integer := 0;
BEGIN
  FOR v_rec IN
    SELECT cs.id, cs.status, s.section_id, s.room_id,
           ((cs.session_date + s.start_time) AT TIME ZONE 'Asia/Manila') AS starts_at,
           ((cs.session_date + s.end_time)   AT TIME ZONE 'Asia/Manila') AS ends_at
      FROM public.class_sessions cs
      JOIN public.schedules s ON s.id = cs.schedule_id
     WHERE cs.status <> 'closed'
       AND (cs.session_date + s.end_time) <= v_local
     ORDER BY cs.id
       FOR UPDATE OF cs SKIP LOCKED
  LOOP
    IF v_rec.status = 'pending' THEN
      PERFORM public.roll_in_students(v_rec.id, v_rec.starts_at);
    ELSIF v_rec.status IN ('ongoing', 'substituted') THEN
      INSERT INTO public.attendance_logs (session_id, student_id, room_id, rfid_uid, status, device_id, "timestamp")
      SELECT v_rec.id, st.id, v_rec.room_id, st.rfid_uid, 'absent', 'SYSTEM', v_rec.ends_at
        FROM public.students st
       WHERE st.section_id = v_rec.section_id
         AND NOT EXISTS (SELECT 1 FROM public.attendance_logs al
                          WHERE al.session_id = v_rec.id AND al.student_id = st.id)
      ON CONFLICT (session_id, student_id) WHERE session_id IS NOT NULL DO NOTHING;
    END IF;
    UPDATE public.class_sessions cs SET status = 'closed' WHERE cs.id = v_rec.id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- pg_cron runs these as the database owner; the backend (service role) may call them for tests/admin tools.
REVOKE ALL ON FUNCTION public.roll_in_students(uuid, timestamptz)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_class_session(uuid, uuid, timestamptz, text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_daily_sessions(timestamptz)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_no_teacher_sessions(timestamptz, integer)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_ended_sessions(timestamptz)                      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.roll_in_students(uuid, timestamptz)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.open_class_session(uuid, uuid, timestamptz, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_daily_sessions(timestamptz)                TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_no_teacher_sessions(timestamptz, integer)      TO service_role;
GRANT EXECUTE ON FUNCTION public.close_ended_sessions(timestamptz)                   TO service_role;

COMMIT;
