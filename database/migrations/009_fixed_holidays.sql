-- 009_fixed_holidays: seeds the fixed-date Philippine holidays into no_class_days, every year.
-- Apply by hand (Render does not run migrations). Needs 008 first. Safe to re-run (a seeded year is skipped).
--
--   holiday_seed_years              one row per year already seeded; a year in here is never seeded again,
--                                   so an admin who deletes a holiday keeps it deleted
--   seed_fixed_holidays(p_year)     inserts the 11 fixed dates for p_year that are today (Manila) or later,
--                                   reason = the holiday name, ON CONFLICT DO NOTHING (an admin's own row wins),
--                                   cancels unfinished sessions on the inserted dates, records the year,
--                                   returns how many dates it inserted (0 if the year was already seeded)
--   cron job seed_fixed_holidays    monthly at 16:00 UTC on the 1st (= 00:00 on the 2nd in Manila), seeds the current
--                                   and the next Manila year; both calls are idempotent, so a missed run catches up
--
-- Left out on purpose: dates set by proclamation (Nov 2, Dec 24, Feb 25) and moving dates
-- (National Heroes Day, Holy Week, Eid). An admin adds those by hand.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

CREATE TABLE IF NOT EXISTS public.holiday_seed_years (
  year      int PRIMARY KEY,
  seeded_at timestamptz DEFAULT now()
);
-- Backend (service role) only; same posture as the other tables (RLS on, no policies).
ALTER TABLE public.holiday_seed_years ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.seed_fixed_holidays(p_year int)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_n     integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.holiday_seed_years y WHERE y.year = p_year) THEN
    RETURN 0;
  END IF;

  -- Data-modifying CTEs always run to completion, so the UPDATE runs although the final SELECT only reads ins.
  WITH ins AS (
    INSERT INTO public.no_class_days (day, reason)
    SELECT make_date(p_year, h.m, h.d), h.name
      FROM (VALUES
        (1,  1,  'New Year''s Day'),
        (4,  9,  'Araw ng Kagitingan'),
        (5,  1,  'Labor Day'),
        (6,  12, 'Independence Day'),
        (8,  21, 'Ninoy Aquino Day'),
        (11, 1,  'All Saints'' Day'),
        (11, 30, 'Bonifacio Day'),
        (12, 8,  'Feast of the Immaculate Conception'),
        (12, 25, 'Christmas Day'),
        (12, 30, 'Rizal Day'),
        (12, 31, 'Last Day of the Year')
      ) AS h(m, d, name)
     WHERE make_date(p_year, h.m, h.d) >= v_today
    ON CONFLICT (day) DO NOTHING
    RETURNING day
  ), cancelled AS (
    UPDATE public.class_sessions cs SET status = 'cancelled'
     WHERE cs.session_date IN (SELECT i.day FROM ins i)
       AND cs.status NOT IN ('closed', 'cancelled')
    RETURNING cs.id
  )
  SELECT count(*) INTO v_n FROM ins;

  INSERT INTO public.holiday_seed_years (year) VALUES (p_year) ON CONFLICT (year) DO NOTHING;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_fixed_holidays(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_fixed_holidays(int) TO service_role;

-- Re-runnable: drop the old job first, then schedule it again.
SELECT cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'seed_fixed_holidays';
SELECT cron.schedule('seed_fixed_holidays', '0 16 1 * *',
  $$SELECT public.seed_fixed_holidays(extract(year FROM now() AT TIME ZONE 'Asia/Manila')::int);
    SELECT public.seed_fixed_holidays(extract(year FROM now() AT TIME ZONE 'Asia/Manila')::int + 1)$$);

-- Seed this year (only the dates still ahead) and next year.
SELECT public.seed_fixed_holidays(2026);
SELECT public.seed_fixed_holidays(2027);

COMMIT;

-- Verification (run by hand after applying):
--   SELECT * FROM public.holiday_seed_years;                                  -- 2026, 2027
--   SELECT day, reason FROM public.no_class_days ORDER BY day;                -- 2026: Nov 30 onward; 2027: all 11
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'seed_fixed_holidays';
--   SELECT public.seed_fixed_holidays(2027);                                  -- expect 0 (already seeded)
