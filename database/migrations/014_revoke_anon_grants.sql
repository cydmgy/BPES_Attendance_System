-- 014_revoke_anon_grants: the public API roles (anon, authenticated) get no access to anything in schema public.
-- Apply by hand (Render does not run migrations). Safe to re-run. Nothing breaks: the backend only uses the
-- service-role key (which bypasses grants and RLS), no browser talks to Supabase directly, and RLS is already on
-- with no policies; this removes the Supabase default grants as a second lock.
--
--   existing tables, sequences, functions   REVOKE ALL from anon and authenticated
--   future ones                             ALTER DEFAULT PRIVILEGES so new objects start closed too
--                                           (applies to objects created by the role running this, i.e. postgres)
--
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
