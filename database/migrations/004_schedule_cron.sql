-- ============================================================
-- 004_schedule_cron.sql
-- Phase 4 (part 2): enable pg_cron and run the session jobs every minute.
-- Idempotent: cron.schedule() with an existing job name replaces that job.
-- The functions compute every date/time in Asia/Manila themselves, so the cron timezone does not matter.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

SELECT cron.schedule('generate_daily_sessions', '* * * * *', 'SELECT public.generate_daily_sessions()');
SELECT cron.schedule('mark_no_teacher_sessions', '* * * * *', 'SELECT public.mark_no_teacher_sessions()');
SELECT cron.schedule('close_ended_sessions',     '* * * * *', 'SELECT public.close_ended_sessions()');

-- Three runs a minute add ~4,300 rows/day to cron.job_run_details and pg_cron never prunes it.
SELECT cron.schedule('prune_cron_history', '0 19 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$$);

COMMIT;
