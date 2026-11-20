-- 008_no_class_days: days with no classes (holiday, suspension) and a 'cancelled' session status.
-- Apply by hand (Render does not run migrations), and BEFORE deploying code that reads no_class_days
-- or writes status 'cancelled'.
--
--   no_class_days                   one row per calendar day (Asia/Manila) with no classes
--   class_sessions.status           gains 'cancelled'; the jobs never touch cancelled rows
--   generate_daily_sessions()       creates no sessions for a no-class day
--   mark_no_teacher_sessions()      skips no-class days (cancelled is already excluded: it only reads 'pending')
--   close_ended_sessions()          skips no-class days; status NOT IN ('closed','cancelled')
-- roll_in_students and open_class_session are unchanged (open_class_session only opens pending / no_teacher).

BEGIN;

CREATE TABLE IF NOT EXISTS public.no_class_days (
  day        date PRIMARY KEY,
  reason     text NOT NULL,
  created_at timestamptz DEFAULT now()
);
-- Backend (service role) only; same posture as the other tables (RLS on, no policies).
ALTER TABLE public.no_class_days ENABLE ROW LEVEL SECURITY;

-- The status CHECK in 001 is inline and unnamed (Postgres would call it class_sessions_status_check, but do
-- not rely on that): drop every CHECK on class_sessions that mentions status, then re-add it with the new value.
DO $$
DECLARE
  v_con record;
BEGIN
  FOR v_con IN
    SELECT c.conname
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.class_sessions'::regclass
       AND c.contype = 'c'
       AND pg_catalog.pg_get_constraintdef(c.oid) ~* '\mstatus\M'
  LOOP
    EXECUTE format('ALTER TABLE public.class_sessions DROP CONSTRAINT %I', v_con.conname);
  END LOOP;
END;
$$;
ALTER TABLE public.class_sessions
  ADD CONSTRAINT class_sessions_status_check
  CHECK (status IN ('pending', 'ongoing', 'substituted', 'no_teacher', 'closed', 'cancelled'));

-- Same as 003, except a no-class day gets no sessions.
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
     AND NOT EXISTS (SELECT 1 FROM public.no_class_days n WHERE n.day = v_local::date)
  ON CONFLICT (schedule_id, session_date) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Same as 003, except sessions on a no-class day are skipped (only 'pending' rows are read, so cancelled is never touched).
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
       AND NOT EXISTS (SELECT 1 FROM public.no_class_days n WHERE n.day = cs.session_date)
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

-- Same as 003, except cancelled sessions and sessions on a no-class day are left alone.
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
     WHERE cs.status NOT IN ('closed', 'cancelled')
       AND (cs.session_date + s.end_time) <= v_local
       AND NOT EXISTS (SELECT 1 FROM public.no_class_days n WHERE n.day = cs.session_date)
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

REVOKE ALL ON FUNCTION public.generate_daily_sessions(timestamptz)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_no_teacher_sessions(timestamptz, integer)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_ended_sessions(timestamptz)                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_daily_sessions(timestamptz)           TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_no_teacher_sessions(timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_ended_sessions(timestamptz)              TO service_role;

COMMIT;

-- Verification (run by hand after applying; do not leave test rows behind). Pick a weekday that has active schedules.
--   INSERT INTO public.no_class_days (day, reason) VALUES ('2099-01-05', 'ZZ_test');   -- 2099-01-05 is a Monday
--   SELECT public.generate_daily_sessions('2099-01-05 08:00+08'::timestamptz);         -- expect 0
--   SELECT count(*) FROM public.class_sessions WHERE session_date = '2099-01-05';      -- expect 0
--   DELETE FROM public.no_class_days WHERE day = '2099-01-05';
--   SELECT public.generate_daily_sessions('2099-01-05 08:00+08'::timestamptz);         -- expect > 0 (control)
--   DELETE FROM public.class_sessions WHERE session_date = '2099-01-05';               -- clean up control rows
