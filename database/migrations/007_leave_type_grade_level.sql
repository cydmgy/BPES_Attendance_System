-- 007_leave_type_grade_level: leave is whole day or half day (AM / PM); sections get a grade level.
-- Apply by hand (Render does not run migrations), and BEFORE deploying code that reads these columns.

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS leave_type text NOT NULL DEFAULT 'whole_day';
ALTER TABLE public.leave_requests
  DROP CONSTRAINT IF EXISTS leave_requests_leave_type_check;
ALTER TABLE public.leave_requests
  ADD CONSTRAINT leave_requests_leave_type_check
  CHECK (leave_type IN ('whole_day', 'half_day_am', 'half_day_pm'));

ALTER TABLE public.sections
  ADD COLUMN IF NOT EXISTS grade_level smallint;
ALTER TABLE public.sections
  DROP CONSTRAINT IF EXISTS sections_grade_level_check;
ALTER TABLE public.sections
  ADD CONSTRAINT sections_grade_level_check CHECK (grade_level BETWEEN 1 AND 6);

-- roll_in_students: an approved leave excuses a period when its subject matches (old requests that
-- named one) AND its type covers the period: whole day, morning (starts before 12:00) or afternoon.
-- Same rule as leaveCoversPeriod in backend/src/utils/leave.js. open_class_session only calls this.
CREATE OR REPLACE FUNCTION public.roll_in_students(p_session_id uuid, p_when timestamp with time zone)
 RETURNS TABLE(o_cloned integer, o_excused integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_sess    record;
  v_cloned  integer := 0;
  v_excused integer := 0;
BEGIN
  SELECT cs.id, cs.session_date, s.section_id, s.subject_id, s.room_id, s.start_time
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
              AND (lr.subject_id IS NULL OR lr.subject_id = v_sess.subject_id)
              AND (lr.leave_type = 'whole_day'
                   OR (lr.leave_type = 'half_day_am' AND v_sess.start_time <  TIME '12:00')
                   OR (lr.leave_type = 'half_day_pm' AND v_sess.start_time >= TIME '12:00')))
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
$function$;
