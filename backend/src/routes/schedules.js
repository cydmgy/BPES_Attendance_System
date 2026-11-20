// /api/schedules — master timetable (admin-managed), section-first.
// GET    /                              list (filters: section_id, teacher_id, room_id, day, status=active|archived|all)
// GET    /availability?day&start&end    busy rooms/teachers/sections for a slot (exclude_id = schedule being edited)
// POST   /                              create — room is always the section's home room
// PUT    /:id                           update subject/teacher/day/times/status
// DELETE /:id
// POST   /:id/co-teachers               { teacher_id }      DELETE /:id/co-teachers/:teacherId
// POST   /:id/overrides                 { override_date, sub_teacher_id }   DELETE /:id/overrides/:date
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { localDateStr } = require('../utils/time');
const { addDays } = require('../utils/report');
const { DAYS, isUuid, normTime, dayNameOf, overlaps, scheduleDbError } = require('../utils/schedule');

const SELECT = `id, subject_id, section_id, room_id, teacher_id, day_of_week, start_time, end_time, status,
  subjects(id, name, code), sections(id, section_name, grade_level), rooms(id, name),
  teacher:instructors!teacher_id(id, full_name),
  schedule_co_teachers(teacher_id, instructors(id, full_name)),
  schedule_overrides(id, override_date, sub_teacher_id, instructors(id, full_name))`;

const dayOrder = (a, b) => DAYS.indexOf(a.day_of_week) - DAYS.indexOf(b.day_of_week) || a.start_time.localeCompare(b.start_time);

// GET /api/schedules/my-week — the caller's own active timetable. Registered before the admin-only gate.
//   student: their section's periods
//   teacher: periods they teach or co-teach, plus substitutions in the next 7 days
router.get('/my-week', auth, async (req, res) => {
  try {
    if (req.user?.role === 'student') {
      const { data: st } = await supabase.from('students').select('section_id').eq('id', req.user.id).maybeSingle();
      if (!st?.section_id) return res.json({ schedules: [], substitutions: [] });
      const { data, error } = await supabase.from('schedules').select(SELECT)
        .eq('section_id', st.section_id).eq('status', 'active');
      if (error) throw error;
      return res.json({ schedules: data.sort(dayOrder), substitutions: [] });
    }

    const teacherId = req.user?.instructor_id || req.user?.id;
    if (!isUuid(teacherId)) return fail(res, 403, 'Permission denied'); // also keeps .or() below safe
    const { data: co, error: coErr } = await supabase.from('schedule_co_teachers').select('schedule_id').eq('teacher_id', teacherId);
    if (coErr) throw coErr;
    const coIds = co.map(c => c.schedule_id);
    let q = supabase.from('schedules').select(SELECT).eq('status', 'active');
    q = coIds.length ? q.or(`teacher_id.eq.${teacherId},id.in.(${coIds.join(',')})`) : q.eq('teacher_id', teacherId);

    const today = localDateStr();
    const [{ data: own, error: e1 }, { data: subs, error: e2 }] = await Promise.all([
      q,
      supabase.from('schedule_overrides').select(`override_date, schedules(${SELECT})`)
        .eq('sub_teacher_id', teacherId).gte('override_date', today).lte('override_date', addDays(today, 6))
        .order('override_date'),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    return res.json({
      schedules: own.sort(dayOrder),
      substitutions: subs.map(s => ({ override_date: s.override_date, schedule: s.schedules })),
    });
  } catch (err) {
    console.error('[GET /schedules/my-week]', err);
    return fail(res, 500, 'Failed to fetch timetable');
  }
});

router.use(auth, adminOnly);

const fail = (res, status, error, extra) => res.status(status).json({ error, ...extra });

async function loadSchedule(id) {
  if (!isUuid(id)) return null;
  const { data } = await supabase.from('schedules')
    .select('id, teacher_id, day_of_week, start_time, end_time').eq('id', id).maybeSingle();
  return data;
}

async function fetchOne(id) {
  const { data, error } = await supabase.from('schedules').select(SELECT).eq('id', id).single();
  if (error) throw error;
  return data;
}

// GET /api/schedules
router.get('/', async (req, res) => {
  try {
    const { section_id, teacher_id, room_id, day, status = 'active' } = req.query;
    let q = supabase.from('schedules').select(SELECT).order('start_time');
    if (status !== 'all') q = q.eq('status', status);
    if (section_id) q = q.eq('section_id', section_id);
    if (teacher_id) q = q.eq('teacher_id', teacher_id);
    if (room_id)    q = q.eq('room_id', room_id);
    if (day)        q = q.eq('day_of_week', day);
    const { data, error } = await q;
    if (error) throw error;
    return res.json({ schedules: data || [] });
  } catch (err) {
    console.error('[GET /schedules]', err);
    return fail(res, 500, 'Failed to fetch schedules');
  }
});

// GET /api/schedules/availability?day=Monday&start=08:00&end=09:00
router.get('/availability', async (req, res) => {
  try {
    const { day, exclude_id } = req.query;
    const start = normTime(req.query.start);
    const end = normTime(req.query.end);
    if (!DAYS.includes(day) || !start || !end || end <= start) {
      return fail(res, 400, 'day, start and end (HH:MM, end after start) are required');
    }
    let q = supabase.from('schedules').select('room_id, teacher_id, section_id')
      .eq('status', 'active').eq('day_of_week', day).lt('start_time', end).gt('end_time', start);
    if (isUuid(exclude_id)) q = q.neq('id', exclude_id);
    const { data, error } = await q;
    if (error) throw error;
    const uniq = key => [...new Set((data || []).map(r => r[key]).filter(Boolean))];
    return res.json({ rooms: uniq('room_id'), teachers: uniq('teacher_id'), sections: uniq('section_id') });
  } catch (err) {
    console.error('[GET /schedules/availability]', err);
    return fail(res, 500, 'Failed to check availability');
  }
});

// POST /api/schedules { section_id, subject_id, teacher_id?, day_of_week, start_time, end_time }
router.post('/', async (req, res) => {
  try {
    const { section_id, subject_id, teacher_id = null, day_of_week } = req.body;
    const start = normTime(req.body.start_time);
    const end = normTime(req.body.end_time);
    if (!isUuid(section_id) || !isUuid(subject_id)) return fail(res, 400, 'section_id and subject_id are required');
    if (teacher_id && !isUuid(teacher_id)) return fail(res, 400, 'Invalid teacher');
    if (!DAYS.includes(day_of_week)) return fail(res, 400, `day_of_week must be one of ${DAYS.join(', ')}`);
    if (!start || !end) return fail(res, 400, 'start_time and end_time must be HH:MM');
    if (end <= start) return fail(res, 400, 'End time must be after start time');

    const { data: section } = await supabase.from('sections').select('home_room_id').eq('id', section_id).maybeSingle();
    if (!section) return fail(res, 400, 'Section does not exist');
    if (!section.home_room_id) return fail(res, 400, 'Assign a home room to this section first');

    // room_id from the client (if any) is ignored on purpose: the section's home room decides.
    const { data, error } = await supabase.from('schedules').insert({
      section_id, subject_id, teacher_id: teacher_id || null, day_of_week,
      start_time: start, end_time: end, room_id: section.home_room_id,
    }).select('id').single();
    if (error) {
      const mapped = scheduleDbError(error);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw error;
    }
    return res.status(201).json({ schedule: await fetchOne(data.id) });
  } catch (err) {
    console.error('[POST /schedules]', err);
    return fail(res, 500, 'Failed to create schedule');
  }
});

// PUT /api/schedules/:id
router.put('/:id', async (req, res) => {
  try {
    if (!(await loadSchedule(req.params.id))) return fail(res, 404, 'Schedule not found');
    const b = req.body;
    const u = {};
    if (b.subject_id !== undefined) {
      if (!isUuid(b.subject_id)) return fail(res, 400, 'Invalid subject');
      u.subject_id = b.subject_id;
    }
    if (b.teacher_id !== undefined) {
      if (b.teacher_id && !isUuid(b.teacher_id)) return fail(res, 400, 'Invalid teacher');
      u.teacher_id = b.teacher_id || null;
    }
    if (b.day_of_week !== undefined) {
      if (!DAYS.includes(b.day_of_week)) return fail(res, 400, `day_of_week must be one of ${DAYS.join(', ')}`);
      u.day_of_week = b.day_of_week;
    }
    for (const k of ['start_time', 'end_time']) {
      if (b[k] === undefined) continue;
      const t = normTime(b[k]);
      if (!t) return fail(res, 400, `${k} must be HH:MM`);
      u[k] = t;
    }
    if (b.status !== undefined) {
      if (!['active', 'archived'].includes(b.status)) return fail(res, 400, 'status must be active or archived');
      u.status = b.status;
    }
    if (!Object.keys(u).length) return fail(res, 400, 'No update fields provided');

    const { error } = await supabase.from('schedules').update(u).eq('id', req.params.id);
    if (error) {
      const mapped = scheduleDbError(error);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw error;
    }
    return res.json({ schedule: await fetchOne(req.params.id) });
  } catch (err) {
    console.error('[PUT /schedules/:id]', err);
    return fail(res, 500, 'Failed to update schedule');
  }
});

// DELETE /api/schedules/:id — blocked once class sessions exist (archive instead)
router.delete('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return fail(res, 404, 'Schedule not found');
    const { error } = await supabase.from('schedules').delete().eq('id', req.params.id);
    if (error?.code === '23503') return fail(res, 409, 'Schedule has class session history; archive it instead');
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /schedules/:id]', err);
    return fail(res, 500, 'Failed to delete schedule');
  }
});

// POST /api/schedules/:id/co-teachers { teacher_id }
router.post('/:id/co-teachers', async (req, res) => {
  try {
    const sched = await loadSchedule(req.params.id);
    if (!sched) return fail(res, 404, 'Schedule not found');
    const { teacher_id } = req.body;
    if (!isUuid(teacher_id)) return fail(res, 400, 'teacher_id is required');
    if (teacher_id === sched.teacher_id) return fail(res, 400, 'That teacher is already the main teacher');

    const { error } = await supabase.from('schedule_co_teachers').insert({ schedule_id: sched.id, teacher_id });
    if (error?.code === '23505') return fail(res, 409, 'Already a co-teacher on this schedule');
    if (error?.code === '23503') return fail(res, 400, 'Teacher does not exist');
    if (error) throw error;
    return res.status(201).json({ schedule: await fetchOne(sched.id) });
  } catch (err) {
    console.error('[POST /schedules/:id/co-teachers]', err);
    return fail(res, 500, 'Failed to add co-teacher');
  }
});

// DELETE /api/schedules/:id/co-teachers/:teacherId
router.delete('/:id/co-teachers/:teacherId', async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.teacherId)) return fail(res, 404, 'Not found');
    const { error } = await supabase.from('schedule_co_teachers')
      .delete().eq('schedule_id', req.params.id).eq('teacher_id', req.params.teacherId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /schedules/:id/co-teachers]', err);
    return fail(res, 500, 'Failed to remove co-teacher');
  }
});

// POST /api/schedules/:id/overrides { override_date: 'YYYY-MM-DD', sub_teacher_id }
// The DB constraints do not see substitutes, so double-booking is checked here.
// shortcut: a regular teacher who is themselves substituted out that day still counts as busy; refine if admins hit it.
router.post('/:id/overrides', async (req, res) => {
  try {
    const sched = await loadSchedule(req.params.id);
    if (!sched) return fail(res, 404, 'Schedule not found');
    const { override_date, sub_teacher_id } = req.body;
    if (!isUuid(sub_teacher_id)) return fail(res, 400, 'sub_teacher_id is required');
    const dayName = dayNameOf(override_date);
    if (!dayName) return fail(res, 400, 'override_date must be YYYY-MM-DD');
    if (override_date < localDateStr()) return fail(res, 400, 'override_date cannot be in the past');
    if (dayName !== sched.day_of_week) return fail(res, 400, `That date is a ${dayName}; this schedule runs on ${sched.day_of_week}`);

    const busy = { conflict: 'teacher' };
    const { data: regular, error: e1 } = await supabase.from('schedules').select('start_time, end_time')
      .eq('status', 'active').eq('teacher_id', sub_teacher_id).eq('day_of_week', sched.day_of_week);
    if (e1) throw e1;
    if (regular.some(r => overlaps(r.start_time, r.end_time, sched.start_time, sched.end_time))) {
      return fail(res, 409, 'That teacher has a class at this time', busy);
    }

    const { data: subs, error: e2 } = await supabase.from('schedule_overrides')
      .select('schedules!inner(start_time, end_time)').eq('sub_teacher_id', sub_teacher_id)
      .eq('override_date', override_date).neq('schedule_id', sched.id);
    if (e2) throw e2;
    if (subs.some(r => overlaps(r.schedules.start_time, r.schedules.end_time, sched.start_time, sched.end_time))) {
      return fail(res, 409, 'That teacher is already substituting at this time', busy);
    }

    const { error } = await supabase.from('schedule_overrides')
      .insert({ schedule_id: sched.id, override_date, sub_teacher_id });
    if (error?.code === '23505') return fail(res, 409, 'This schedule already has a substitute on that date');
    if (error?.code === '23503') return fail(res, 400, 'Teacher does not exist');
    if (error) throw error;
    return res.status(201).json({ schedule: await fetchOne(sched.id) });
  } catch (err) {
    console.error('[POST /schedules/:id/overrides]', err);
    return fail(res, 500, 'Failed to add substitute');
  }
});

// DELETE /api/schedules/:id/overrides/:date
router.delete('/:id/overrides/:date', async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !dayNameOf(req.params.date)) return fail(res, 404, 'Not found');
    const { error } = await supabase.from('schedule_overrides')
      .delete().eq('schedule_id', req.params.id).eq('override_date', req.params.date);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /schedules/:id/overrides]', err);
    return fail(res, 500, 'Failed to remove substitute');
  }
});

module.exports = router;
