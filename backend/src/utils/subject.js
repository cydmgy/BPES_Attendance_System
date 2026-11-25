// Validate and normalise a subject request body. partial=true is for PUT (only given fields).
function cleanSubjectBody(body = {}, { partial }) {
  const fields = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) return { ok: false, error: 'Subject name is required' };
    fields.name = name;
  }
  const raw = body.late_threshold_minutes;
  if (raw !== undefined || !partial) {
    const n = !partial && raw == null ? 15
      : (typeof raw === 'number' || typeof raw === 'string') && String(raw).trim() !== '' ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 120) return { ok: false, error: 'late_threshold_minutes must be a whole number from 0 to 120' };
    fields.late_threshold_minutes = n;
  }
  if (body.school_year !== undefined || !partial) fields.school_year = String(body.school_year || '2026-2027').trim();
  if (!Object.keys(fields).length) return { ok: false, error: 'No update fields provided' };
  return { ok: true, fields };
}

module.exports = { cleanSubjectBody };
