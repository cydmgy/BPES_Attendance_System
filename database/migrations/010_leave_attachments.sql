-- 010_leave_attachments: up to 3 files (JPG, PNG, WebP or PDF, 5 MB each) on a leave request.
-- Apply by hand (Render does not run migrations), before deploying the code that uses it. Safe to re-run.
--
--   leave_attachments            one row per file; slot 1..3 is unique per request, deleted with the request.
--                                RLS on, no policies: only the service-role key reads or writes
--   storage bucket               leave-attachments, private, 5 MB limit, the four types above.
--                                The API streams files through the server, so nothing is ever public
--
CREATE TABLE IF NOT EXISTS leave_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id UUID NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 3),
  storage_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (leave_request_id, slot)
);
ALTER TABLE leave_attachments ENABLE ROW LEVEL SECURITY;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('leave-attachments', 'leave-attachments', false, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;
