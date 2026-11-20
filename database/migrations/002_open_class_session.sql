-- ============================================================
-- 002_open_class_session.sql
-- Phase 3: a teacher tap opens a class session and rolls the section's
-- present students into it. Idempotent (CREATE OR REPLACE). Apply after 001.
-- ============================================================

BEGIN;

-- Opens (or re-reads) today's session for a schedule, in one transaction, safe to retry:
--   * creates the session row if missing, locks it so concurrent taps serialise;
--   * pending / no_teacher -> p_status ('ongoing' | 'substituted'), records teacher + time;
--     any other status (already open, or closed) is left as is: a second tap is a no-op;
--   * when it opens, section students with approved leave for the date (all-day or this
--     subject) get 'excused', then everyone checked in today (daily_presence) gets 'present'.
--     ON CONFLICT DO NOTHING keeps existing logs, so re-running never duplicates or overwrites.
-- Output columns are o_-prefixed so they cannot shadow table columns inside the body.
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
  v_sched   record;
  v_session public.class_sessions%ROWTYPE;
  v_opened  boolean := false;
  v_cloned  integer := 0;
  v_excused integer := 0;
BEGIN
  IF p_status NOT IN ('ongoing', 'substituted') THEN
    RAISE EXCEPTION 'open_class_session: invalid status %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT s.id, s.section_id, s.subject_id, s.room_id
    INTO v_sched
    FROM public.schedules s
   WHERE s.id = p_schedule_id;
  IF NOT FOUND THEN
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

    -- Leave first, so a student on leave is 'excused' even if they tapped in this morning.
    INSERT INTO public.attendance_logs (session_id, student_id, room_id, rfid_uid, status, device_id, "timestamp")
    SELECT v_session.id, st.id, v_sched.room_id, st.rfid_uid, 'excused', 'SYSTEM', p_tap_time
      FROM public.students st
     WHERE st.section_id = v_sched.section_id
       AND EXISTS (
             SELECT 1 FROM public.leave_requests lr
              WHERE lr.student_id = st.id
                AND lr.leave_date = v_date
                AND lr.status = 'approved'
                AND (lr.subject_id IS NULL OR lr.subject_id = v_sched.subject_id))
    ON CONFLICT (session_id, student_id) WHERE session_id IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_excused = ROW_COUNT;

    INSERT INTO public.attendance_logs (session_id, student_id, room_id, rfid_uid, status, device_id, "timestamp")
    SELECT v_session.id, st.id, v_sched.room_id, st.rfid_uid, 'present', 'SYSTEM', p_tap_time
      FROM public.daily_presence dp
      JOIN public.students st ON st.id = dp.student_id
     WHERE dp.attendance_date = v_date
       AND dp.is_present
       AND st.section_id = v_sched.section_id
    ON CONFLICT (session_id, student_id) WHERE session_id IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_cloned = ROW_COUNT;
  END IF;

  RETURN QUERY
  SELECT v_session.id, v_session.status::text, v_session.teacher_time_in, v_opened, v_cloned, v_excused;
END;
$$;

-- Backend (service role) only; same posture as the tables (RLS on, no policies).
REVOKE ALL ON FUNCTION public.open_class_session(uuid, uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_class_session(uuid, uuid, timestamptz, text) TO service_role;

COMMIT;
