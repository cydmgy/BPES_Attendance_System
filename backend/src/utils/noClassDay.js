const MAX_RANGE_DAYS = 31;
// toJSON is null for month 13; the compare rejects 2026-02-30
const isRealDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
  && new Date(`${d}T00:00:00Z`).toJSON()?.slice(0, 10) === d;

// Validates a no-class-day request body. today is the Manila date 'YYYY-MM-DD'.
// Optional body.until makes an inclusive range (empty = one day, max 31 days).
// Returns { day, until, days, reason } or { error }.
function parseNoClassDay(body, today) {
  const day = body?.day;
  if (!isRealDate(day)) return { error: 'day must be a real date as YYYY-MM-DD' };
  const until = body.until == null || body.until === '' ? day : body.until;
  if (!isRealDate(until)) return { error: 'until must be a real date as YYYY-MM-DD' };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return { error: 'A reason is required' };
  if (day < today) return { error: 'day cannot be in the past' };
  if (until < day) return { error: 'until cannot be before day' };
  const days = [];
  for (let t = Date.parse(day); t <= Date.parse(until); t += 864e5) {
    if (days.length === MAX_RANGE_DAYS) return { error: `A range can cover at most ${MAX_RANGE_DAYS} days` };
    days.push(new Date(t).toJSON().slice(0, 10));
  }
  return { day, until, days, reason };
}

// What /api/scan answers on a no-class day: 200 (409 already means duplicate tap) so the reader can show the reason.
const noClassBody = (reason) => ({ success: false, role: 'none', status: 'no_class', reason: reason ?? null });

module.exports = { parseNoClassDay, noClassBody };
