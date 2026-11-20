// Pure tap-engine rules (no DB access, unit-tested).

// A tap this many minutes before a period starts already belongs to that period,
// so at 08:50 a 09:00 class takes the tap, not the 08:00-09:00 one still running.
const LOOKAHEAD_MINUTES = 10;

// 'HH:MM' or 'HH:MM:SS' -> minutes since midnight
const toMinutes = t => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};

// The period a tap at `minutes` belongs to, from one room's active schedules for the day.
// Candidates are periods with start - LOOKAHEAD <= minutes < end; the latest-starting wins.
// Active periods in a room never overlap (DB constraint), so there are at most two candidates.
function resolveSlot(schedules, minutes) {
  let best = null;
  for (const s of schedules || []) {
    const start = toMinutes(s.start_time);
    const end = toMinutes(s.end_time);
    if (start - LOOKAHEAD_MINUTES <= minutes && minutes < end && (!best || start > toMinutes(best.start_time))) {
      best = s;
    }
  }
  return best;
}

// Session status a teacher's tap opens, or null if they may not open this period.
// Regular or co-teacher -> 'ongoing'; today's substitute -> 'substituted'.
function teacherRole(schedule, teacherId, { coTeacherIds = [], subTeacherId = null } = {}) {
  if (!schedule || !teacherId) return null;
  if (schedule.teacher_id === teacherId || coTeacherIds.includes(teacherId)) return 'ongoing';
  if (subTeacherId === teacherId) return 'substituted';
  return null;
}

// A student's own tap into an open session: late once past MAX(start, teacher arrival) + threshold.
// Dates are Date objects; teacherTimeIn may be null (no_teacher sessions count from the start).
function studentTapStatus({ tapAt, startAt, teacherTimeIn = null, thresholdMinutes }) {
  const base = teacherTimeIn && teacherTimeIn > startAt ? teacherTimeIn : startAt;
  const cutoff = base.getTime() + (thresholdMinutes ?? 15) * 60 * 1000;
  return tapAt.getTime() > cutoff ? 'late' : 'present';
}

module.exports = { LOOKAHEAD_MINUTES, toMinutes, resolveSlot, teacherRole, studentTapStatus };
