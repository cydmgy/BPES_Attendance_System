// Validate and normalise a subject request body. partial=true is for PUT (only given fields).
function cleanSubjectBody(body = {}, { partial }) {
  const fields = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) return { ok: false, error: 'Subject name is required' };
    fields.name = name;
  }
  const num = (v, def) => (partial ? parseInt(v, 10) : parseInt(v, 10) || def);
  if (body.late_threshold_minutes !== undefined || !partial) fields.late_threshold_minutes = num(body.late_threshold_minutes, 15);
  if (body.school_year !== undefined || !partial) fields.school_year = String(body.school_year || '2026-2027').trim();
  if (!Object.keys(fields).length) return { ok: false, error: 'No update fields provided' };
  return { ok: true, fields };
}

module.exports = { cleanSubjectBody };
