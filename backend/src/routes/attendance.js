// /api/attendance — attendance logs, live feed, and reports
// GET /api/attendance           — attendance logs list (supports section, room_id, limit, student filter)
// GET /api/attendance/live      — today's logs for a specific room (live dashboard feed)
// GET /api/attendance/daily     — one day's sessions with status counts
// GET /api/attendance/weekly    — per-student stats over held sessions in a date range
// GET /api/attendance/monthly   — per-student, per-day counts for a month
// GET /api/attendance/absentees — students below an attendance threshold

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');

const { localDateStr, localIso } = require('../utils/time');
const { dayNameOf } = require('../utils/schedule');
const { withSectionName } = require('../utils/section');
const { countStatuses, attendancePercent, aggregateByStudent, addDays, monthRange, buildTrend } = require('../utils/report');

// Logs carry the student's section as a plain `section` name (the join row is lifted away).
const flatLogs = rows => (rows || []).map(l => ({ ...l, students: l.students && withSectionName(l.students) }));

// Class context of a log: which period it belongs to and who taught it (null for pre-session taps).
const SESSION_CONTEXT = `session_id,
        class_sessions(session_date, teacher:instructors!actual_teacher_id(full_name),
          schedules(start_time, end_time, subjects(id, name, code)))`;

// ── GET /api/attendance ──────────────────────────────────────────
// Returns attendance logs (optional room_id, section name, student_id filter, limit)
router.get('/', auth, async (req, res) => {
  try {
    const { room_id, limit = 100, section, student_id } = req.query;

    const selectClause = section
      ? `
        id, rfid_uid, timestamp, status, device_id,
        students!inner(id, full_name, student_id, course, year_level, sections!inner(section_name)),
        rooms(id, name, location),
        ${SESSION_CONTEXT}
      `
      : `
        id, rfid_uid, timestamp, status, device_id,
        students(id, full_name, student_id, course, year_level, sections(section_name)),
        rooms(id, name, location),
        ${SESSION_CONTEXT}
      `;

    let query = supabase
      .from('attendance_logs')
      .select(selectClause)
      .order('timestamp', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 100, 500));

    // If caller is student, strictly limit to their own logs
    if (req.user?.role === 'student') {
      const currentStudentId = req.user.id || req.user.student_id;
      query = query.eq('student_id', currentStudentId);
    } else if (student_id) {
      query = query.eq('student_id', student_id);
    }

    if (room_id) {
      query = query.eq('room_id', room_id);
    }
    if (section) {
      query = query.eq('students.sections.section_name', section);
    }

    const { data, error } = await query;
    if (error) throw error;

    const logs = flatLogs(data);
    return res.json({ logs, count: logs.length });
  } catch (err) {
    console.error('[GET /attendance]', err);
    return res.status(500).json({ error: 'Failed to fetch attendance logs' });
  }
});

// ── GET /api/attendance/live?room_id=xxx ─────────────────────────
// Returns today's attendance logs for a room (used by live dashboard)
router.get('/live', auth, async (req, res) => {
  try {
    // A room's feed lists every student in it: staff only
    if (req.user?.role === 'student') return res.status(403).json({ error: 'Permission denied' });
    const { room_id } = req.query;
    if (!room_id) return res.status(400).json({ error: 'room_id is required' });

    // Local timezone start of day in ISO
    const startOfDay = localIso(localDateStr());

    const { data, error } = await supabase
      .from('attendance_logs')
      .select(`
        id, timestamp, status, device_id,
        students(id, full_name, student_id, course, year_level, sections(section_name)),
        rooms(id, name)
      `)
      .eq('room_id', room_id)
      .gte('timestamp', startOfDay)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    const logs = flatLogs(data);
    return res.json({ logs, count: logs.length });
  } catch (err) {
    console.error('[GET /attendance/live]', err);
    return res.status(500).json({ error: 'Failed to fetch live attendance' });
  }
});

// ── Session-based reports ────────────────────────────────────────
// Every report counts one log per (session, student). "Held" sessions are closed sessions a teacher
// actually opened (teacher_time_in set); every section student has a log in those (absent rows are
// written at close), so a student's attendance % = (present + late + excused) / sessions held.
// Dates are class_sessions.session_date (Asia/Manila calendar days).

const PAGE = 1000; // PostgREST returns at most 1000 rows per request
// shortcut: reports still sum in Node; the proper fix is one SQL GROUP BY function, when a month gets slow.
const MAX_REPORT_DAYS = 93;

async function sessionLogs({ from, to, sectionId, subjectId, roomId, studentId, heldOnly = true }) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase.from('attendance_logs')
      .select(`id, student_id, status,
        students(id, full_name, student_id, sections(section_name)),
        class_sessions!inner(id, session_date, status, teacher_time_in,
          schedules!inner(id, subject_id, section_id, room_id, start_time, end_time,
            subjects(name, code), sections(section_name)))`)
      .gte('class_sessions.session_date', from)
      .lte('class_sessions.session_date', to)
      .order('id')
      .range(offset, offset + PAGE - 1);
    if (heldOnly) q = q.eq('class_sessions.status', 'closed').not('class_sessions.teacher_time_in', 'is', null);
    if (sectionId) q = q.eq('class_sessions.schedules.section_id', sectionId);
    if (subjectId) q = q.eq('class_sessions.schedules.subject_id', subjectId);
    if (roomId)    q = q.eq('class_sessions.schedules.room_id', roomId);
    if (studentId) q = q.eq('student_id', studentId);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows.map(r => ({ student_id: r.student_id, status: r.status, student: r.students && withSectionName(r.students), session: r.class_sessions }));
}

// Students only ever see their own numbers.
const ownStudentId = req => (req.user?.role === 'student' ? (req.user.id || req.user.student_id) : req.query.student_id);

const badDate = d => !dayNameOf(d);

// ── GET /api/attendance/daily?date=YYYY-MM-DD&section_id=&room_id= ──
// All of the day's opened sessions (including ones still running), with per-session counts.
router.get('/daily', auth, async (req, res) => {
  try {
    const date = req.query.date || localDateStr();
    if (badDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const rows = await sessionLogs({
      from: date, to: date, heldOnly: false,
      sectionId: req.query.section_id, roomId: req.query.room_id, studentId: ownStudentId(req),
    });

    const bySession = new Map();
    for (const r of rows) {
      if (!bySession.has(r.session.id)) bySession.set(r.session.id, { session: r.session, rows: [] });
      bySession.get(r.session.id).rows.push(r);
    }
    const sessions = [...bySession.values()]
      .sort((a, b) => a.session.schedules.start_time.localeCompare(b.session.schedules.start_time))
      .map(({ session: s, rows: own }) => ({
        session_id: s.id,
        status: s.status,
        subject: s.schedules.subjects?.name || null,
        section: s.schedules.sections?.section_name || null,
        start_time: s.schedules.start_time,
        end_time: s.schedules.end_time,
        counts: countStatuses(own),
      }));
    const summary = countStatuses(rows);
    return res.json({ date, summary: { ...summary, attendance_rate: attendancePercent(summary) }, sessions });
  } catch (err) {
    console.error('[GET /attendance/daily]', err);
    return res.status(500).json({ error: 'Failed to fetch daily report' });
  }
});

// ── GET /api/attendance/trend?days=14 ──
// Daily counts over the last `days` calendar days (default 14, capped like the other reports) for the dashboard
// charts: held, closed sessions only. Students get their own days; staff get the whole school.
router.get('/trend', auth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), MAX_REPORT_DAYS);
    const to = localDateStr();
    const from = addDays(to, -(days - 1));
    const rows = await sessionLogs({ from, to, studentId: ownStudentId(req) });
    return res.json({ from, to, days: buildTrend(rows) });
  } catch (err) {
    console.error('[GET /attendance/trend]', err);
    return res.status(500).json({ error: 'Failed to fetch attendance trend' });
  }
});

// ── GET /api/attendance/weekly?from=&to=&subject_id=&section_id=&room_id= ──
router.get('/weekly', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (badDate(from) || badDate(to) || from > to) {
      return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD, from <= to)' });
    }
    // The reports add up every log in Node, so the range is capped (about one term)
    if (addDays(from, MAX_REPORT_DAYS - 1) < to) {
      return res.status(400).json({ error: `The date range can be at most ${MAX_REPORT_DAYS} days` });
    }
    const rows = await sessionLogs({
      from, to,
      sectionId: req.query.section_id, subjectId: req.query.subject_id, roomId: req.query.room_id,
      studentId: ownStudentId(req),
    });
    return res.json({
      from, to,
      sessions_held: new Set(rows.map(r => r.session.id)).size,
      report: aggregateByStudent(rows),
    });
  } catch (err) {
    console.error('[GET /attendance/weekly]', err);
    return res.status(500).json({ error: 'Failed to fetch weekly report' });
  }
});

// ── GET /api/attendance/monthly?year=2026&month=11&section_id=&subject_id=&room_id= ──
// Per student: totals for the month and per-day counts keyed by Manila date.
router.get('/monthly', auth, async (req, res) => {
  try {
    const [curYear, curMonth] = localDateStr().split('-').map(Number);
    const year = parseInt(req.query.year || curYear, 10);
    const month = parseInt(req.query.month || curMonth, 10);
    if (!(year >= 2000 && year <= 2100 && month >= 1 && month <= 12)) {
      return res.status(400).json({ error: 'year and month are invalid' });
    }
    const { from, to } = monthRange(year, month);
    const rows = await sessionLogs({
      from, to,
      sectionId: req.query.section_id, subjectId: req.query.subject_id, roomId: req.query.room_id,
      studentId: ownStudentId(req),
    });

    const days = new Map(); // student_id -> { 'YYYY-MM-DD': rows[] }
    for (const r of rows) {
      if (!r.student_id) continue;
      if (!days.has(r.student_id)) days.set(r.student_id, {});
      (days.get(r.student_id)[r.session.session_date] ??= []).push(r);
    }
    const report = aggregateByStudent(rows).map(s => ({
      ...s,
      days: Object.fromEntries(Object.entries(days.get(s.student.id) || {}).map(([d, own]) => [d, countStatuses(own)])),
    }));
    return res.json({ year, month, report });
  } catch (err) {
    console.error('[GET /attendance/monthly]', err);
    return res.status(500).json({ error: 'Failed to fetch monthly report' });
  }
});

// ── GET /api/attendance/absentees?subject_id=&section_id=&threshold=75&days=30 ──
// Students whose attendance % over the last `days` days falls below the threshold
// (default 75; subjects no longer carry their own minimum).
router.get('/absentees', auth, async (req, res) => {
  try {
    if (req.user?.role === 'student') return res.status(403).json({ error: 'Permission denied' });
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), MAX_REPORT_DAYS);
    let threshold = parseInt(req.query.threshold, 10);
    if (!Number.isFinite(threshold)) threshold = 75;

    const to = localDateStr();
    const from = addDays(to, -(days - 1));
    const rows = await sessionLogs({ from, to, subjectId: req.query.subject_id, sectionId: req.query.section_id });
    const absentees = aggregateByStudent(rows)
      .filter(s => s.attendance_percent !== null && s.attendance_percent < threshold)
      .sort((a, b) => a.attendance_percent - b.attendance_percent);
    return res.json({ from, to, threshold, absentees });
  } catch (err) {
    console.error('[GET /attendance/absentees]', err);
    return res.status(500).json({ error: 'Failed to fetch absentees' });
  }
});

module.exports = router;
