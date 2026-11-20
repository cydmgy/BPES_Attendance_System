// Pure report math over session logs (no DB access, unit-tested).
// A "row" is one attendance log of one class session: { student_id, status, student }.

const STATUSES = ['present', 'late', 'excused', 'absent'];

const emptyCounts = () => ({ present: 0, late: 0, excused: 0, absent: 0, total: 0 });

function countStatuses(rows) {
  const c = emptyCounts();
  for (const r of rows || []) {
    if (!STATUSES.includes(r.status)) continue;
    c[r.status]++;
    c.total++;
  }
  return c;
}

// (present + late + excused) / sessions, as a whole percent; null when there is nothing to divide by.
const attendancePercent = c => (c.total ? Math.round(((c.present + c.late + c.excused) / c.total) * 100) : null);

// One entry per student: counts over the sessions they had a log in, and their attendance %.
// Every student of a held, closed session has exactly one log (absent rows are written at close),
// so `sessions` is the number of sessions held for that student.
function aggregateByStudent(rows) {
  const byStudent = new Map();
  for (const r of rows || []) {
    if (!r.student_id || !STATUSES.includes(r.status)) continue;
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, { student: r.student, rows: [] });
    byStudent.get(r.student_id).rows.push(r);
  }
  return [...byStudent.values()].map(({ student, rows: own }) => {
    const c = countStatuses(own);
    return {
      student,
      present: c.present,
      late: c.late,
      excused: c.excused,
      absent: c.absent,
      sessions: c.total,
      attendance_percent: attendancePercent(c),
    };
  });
}

// 'YYYY-MM-DD' shifted by whole days (calendar math, no time zone involved)
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// First and last calendar date of a month (month is 1-12)
function monthRange(year, month) {
  const mm = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

// What a portal shows for one student in one of today's periods.
// A cancelled period always shows 'cancelled' (logs from before a suspension do not count). Otherwise a log wins; otherwise it follows the session: not started -> 'upcoming', open without the
// student -> 'not_checked_in', teacher never came -> 'no_teacher', closed after a held class -> 'absent'.
function studentBadge(session, logStatus) {
  if (session?.status === 'cancelled') return 'cancelled';
  if (logStatus) return logStatus;
  if (!session || session.status === 'pending') return 'upcoming';
  if (session.status === 'no_teacher') return 'no_teacher';
  if (session.status === 'closed') return session.teacher_time_in ? 'absent' : 'no_teacher';
  return 'not_checked_in';
}

// Drops logs whose session was cancelled (a student tapped before a suspension); logs with no session stay.
// A row is { class_sessions: { status } | null }.
const withoutCancelled = rows => (rows || []).filter(r => r.class_sessions?.status !== 'cancelled');

// Daily attendance for the dashboard charts: one entry per date that has counted logs, oldest first.
// Days with no logs (weekends, no classes held) are left out so the chart shows no false drops to zero.
// A row is { status, session: { session_date } }.
function buildTrend(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    const date = r.session?.session_date;
    if (!date || !STATUSES.includes(r.status)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, own]) => {
    const c = countStatuses(own);
    return { date, present: c.present, late: c.late, excused: c.excused, absent: c.absent, total: c.total, rate: attendancePercent(c) };
  });
}

module.exports = { STATUSES, countStatuses, attendancePercent, aggregateByStudent, addDays, monthRange, studentBadge, buildTrend, withoutCancelled };
