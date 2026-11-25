// Pure helpers shared by the schedule/section routes (no DB access, unit-tested).

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

// 'HH:MM' or 'HH:MM:SS' -> 'HH:MM:SS', else null
function normTime(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(v ?? '').trim());
  return m ? `${m[1]}:${m[2]}:${m[3] || '00'}` : null;
}

// 'YYYY-MM-DD' -> weekday name, or null if not a real calendar date
function dayNameOf(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateStr) return null;
  return ['Sunday', ...DAYS][d.getUTCDay()];
}

// Half-open ranges, same as the DB constraints: back-to-back periods do not overlap.
// Times must be normalised 'HH:MM:SS' strings (they compare correctly as text).
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

const CONFLICT_BY_CONSTRAINT = {
  no_room_time_overlap: 'room',
  no_teacher_double_booking: 'teacher',
  no_section_overlap: 'section',
};

// Translate a Postgres/PostgREST error from a schedules write into { status, body }, or null if unknown.
function scheduleDbError(err) {
  const name = /constraint "([^"]+)"/.exec(err?.message || '')?.[1];
  if (err?.code === '23P01') {
    const conflict = CONFLICT_BY_CONSTRAINT[name];
    if (!conflict) return null;
    return { status: 409, body: { error: `That ${conflict} is already booked at that time`, conflict } };
  }
  if (err?.code === '23514' && name === 'chk_schedules_time_order') {
    return { status: 400, body: { error: 'End time must be after start time' } };
  }
  if (err?.code === '23503') {
    return { status: 400, body: { error: 'Section, subject, room or teacher does not exist' } };
  }
  return null;
}

module.exports = { DAYS, isUuid, normTime, dayNameOf, overlaps, scheduleDbError };
