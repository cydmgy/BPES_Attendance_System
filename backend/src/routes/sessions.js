// /api/sessions — class periods of one Asia/Manila day (default today).
// GET /?date=YYYY-MM-DD   (GET /today is the same for today)
//   student: their section's periods, each with the student's own badge
//   teacher: periods they teach, co-teach or substitute today, each with the section roster
//   admin:   every period today with status counts
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const { localNow } = require('../utils/time');
const { countStatuses, studentBadge } = require('../utils/report');
const { isUuid, dayNameOf } = require('../utils/schedule');

const PERIOD = `id, section_id, teacher_id, start_time, end_time,
  subjects(name, code), sections(section_name), rooms(name), teacher:instructors!teacher_id(id, full_name)`;

async function periodsFor(req, res, date) {
  try {
    const role = req.user?.role;
    let q = supabase.from('schedules').select(PERIOD)
      .eq('status', 'active').eq('day_of_week', dayNameOf(date)).order('start_time');

    let student = null;
    if (role === 'student') {
      const { data } = await supabase.from('students').select('id, section_id').eq('id', req.user.id).maybeSingle();
      student = data;
      if (!student?.section_id) return res.json({ date, role, periods: [] });
      q = q.eq('section_id', student.section_id);
    } else if (role !== 'admin') {
      // Teacher: own periods + co-teaching + today's substitutions.
      const teacherId = req.user?.instructor_id || req.user?.id;
      if (!isUuid(teacherId)) return res.status(403).json({ error: 'Permission denied' }); // also keeps .or() below safe
      const [{ data: co, error: e1 }, { data: subs, error: e2 }] = await Promise.all([
        supabase.from('schedule_co_teachers').select('schedule_id').eq('teacher_id', teacherId),
        supabase.from('schedule_overrides').select('schedule_id').eq('sub_teacher_id', teacherId).eq('override_date', date),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const extra = [...(co || []), ...(subs || [])].map(r => r.schedule_id);
      q = extra.length ? q.or(`teacher_id.eq.${teacherId},id.in.(${extra.join(',')})`) : q.eq('teacher_id', teacherId);
    }

    const { data: periods, error } = await q;
    if (error) throw error;
    if (!periods.length) return res.json({ date, role, periods: [] });

    const { data: sessions, error: sErr } = await supabase.from('class_sessions')
      .select('id, schedule_id, status, teacher_time_in, actual_teacher_id')
      .eq('session_date', date).in('schedule_id', periods.map(p => p.id));
    if (sErr) throw sErr;
    const sessionBy = new Map(sessions.map(s => [s.schedule_id, s]));

    let logs = [];
    if (sessions.length) {
      let lq = supabase.from('attendance_logs').select('id, session_id, student_id, status, timestamp').in('session_id', sessions.map(s => s.id));
      if (student) lq = lq.eq('student_id', student.id);
      const { data, error: lErr } = await lq;
      if (lErr) throw lErr;
      logs = data;
    }
    const logBy = new Map(logs.map(l => [`${l.session_id}:${l.student_id}`, l]));

    // Rosters for teachers/admins (one query for all sections involved).
    let rosterBySection = new Map();
    if (!student) {
      const sectionIds = [...new Set(periods.map(p => p.section_id))];
      const { data: studs, error: rErr } = await supabase.from('students')
        .select('id, full_name, student_id, section_id').in('section_id', sectionIds).order('full_name');
      if (rErr) throw rErr;
      for (const s of studs) {
        if (!rosterBySection.has(s.section_id)) rosterBySection.set(s.section_id, []);
        rosterBySection.get(s.section_id).push(s);
      }
    }

    const out = periods.map(p => {
      const s = sessionBy.get(p.id) || null;
      const base = {
        schedule_id: p.id,
        session_id: s?.id || null,
        session_status: s?.status || 'pending',
        start_time: p.start_time,
        end_time: p.end_time,
        subject: p.subjects,
        section: p.sections?.section_name || null,
        room: p.rooms?.name || null,
        teacher: p.teacher,
      };
      if (student) return { ...base, badge: studentBadge(s, s && logBy.get(`${s.id}:${student.id}`)?.status) };
      const roster = (rosterBySection.get(p.section_id) || []).map(st => {
        const log = s && logBy.get(`${s.id}:${st.id}`);
        return { ...st, log_id: log?.id || null, log_status: log?.status || null, log_time: log?.timestamp || null, badge: studentBadge(s, log?.status) };
      });
      return { ...base, counts: countStatuses(roster.map(r => ({ status: r.log_status }))), roster };
    });

    return res.json({ date, role, periods: out });
  } catch (err) {
    console.error('[GET /sessions]', err);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
}

router.get('/today', auth, (req, res) => periodsFor(req, res, localNow().date));
router.get('/', auth, (req, res) => {
  const date = req.query.date || localNow().date;
  if (!dayNameOf(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  return periodsFor(req, res, date);
});

module.exports = router;
