// Validates a no-class-day request body. today is the Manila date 'YYYY-MM-DD'.
// Returns { day, reason } or { error }.
function parseNoClassDay(body, today) {
  const day = body?.day;
  const valid = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && new Date(`${day}T00:00:00Z`).toJSON()?.slice(0, 10) === day; // toJSON is null for month 13; the compare rejects 2026-02-30
  if (!valid) return { error: 'day must be a real date as YYYY-MM-DD' };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return { error: 'A reason is required' };
  if (day < today) return { error: 'day cannot be in the past' };
  return { day, reason };
}

// What /api/scan answers on a no-class day: 200 (409 already means duplicate tap) so the reader can show the reason.
const noClassBody = (reason) => ({ success: false, role: 'none', status: 'no_class', reason: reason ?? null });

module.exports = { parseNoClassDay, noClassBody };
