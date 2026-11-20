-- 006_subjects_seed: elementary subjects are the only subjects; names are unique (case-insensitive).
DELETE FROM public.subjects WHERE name IN ('Web Systems and Technologies', 'Database Management Systems');

CREATE UNIQUE INDEX IF NOT EXISTS subjects_name_lower_uq ON public.subjects (lower(name));

INSERT INTO public.subjects (name, late_threshold_minutes, min_attendance_percent, school_year)
VALUES ('Filipino', 15, 75, '2026-2027'),
       ('English', 15, 75, '2026-2027'),
       ('Mathematics', 15, 75, '2026-2027'),
       ('Science', 15, 75, '2026-2027'),
       ('Araling Panlipunan', 15, 75, '2026-2027')
ON CONFLICT DO NOTHING;
