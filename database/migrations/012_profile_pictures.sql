-- 012_profile_pictures: every user can have one profile picture (JPG, PNG or WebP, 1 MB).
-- Apply by hand (Render does not run migrations). Safe to re-run. Until it is applied only
-- POST/DELETE /api/account/avatar fail; /api/account/me and logins keep working.
--
--   avatar_path                  storage path inside the bucket, null when there is no picture
--   storage bucket               avatars, private, 1 MB limit, the three image types.
--                                The API hands out 1 hour signed links, nothing is ever public
--
ALTER TABLE students       ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE instructors    ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS avatar_path TEXT;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 1048576,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;
