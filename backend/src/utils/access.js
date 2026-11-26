// Who may change a class's records: an admin, the period's teacher, a co-teacher, or that day's substitute.
// Teacher tokens carry instructor_id; student tokens never do.

async function canManageAny(supabase, user, scheduleIds, date) {
  if (user?.role === 'admin') return true;
  const me = user?.instructor_id;
  if (!me || !scheduleIds.length) return false;
  const [own, co, sub] = await Promise.all([
    supabase.from('schedules').select('id').in('id', scheduleIds).eq('teacher_id', me).limit(1),
    supabase.from('schedule_co_teachers').select('schedule_id').in('schedule_id', scheduleIds).eq('teacher_id', me).limit(1),
    supabase.from('schedule_overrides').select('schedule_id').in('schedule_id', scheduleIds)
      .eq('override_date', date).eq('sub_teacher_id', me).limit(1),
  ]);
  return [own, co, sub].some(r => r.data?.length > 0);
}

// A leave request: the reviewer must teach the student's section (that subject, if the leave names one) on leave_date.
async function canReviewLeave(supabase, user, leave) {
  if (user?.role === 'admin') return true;
  if (!user?.instructor_id) return false;
  const { data: st } = await supabase.from('students').select('section_id').eq('id', leave.student_id).maybeSingle();
  if (!st?.section_id) return false;
  let q = supabase.from('schedules').select('id').eq('section_id', st.section_id).eq('status', 'active');
  if (leave.subject_id) q = q.eq('subject_id', leave.subject_id);
  const { data } = await q;
  return canManageAny(supabase, user, (data || []).map(s => s.id), leave.leave_date);
}

// Sections a teacher owns, co-teaches or substitutes in (any date). A cheap superset check before canReviewLeave.
async function teacherSectionIds(supabase, teacherId) {
  if (!teacherId) return new Set();
  const [own, co, sub] = await Promise.all([
    supabase.from('schedules').select('section_id').eq('teacher_id', teacherId),
    supabase.from('schedule_co_teachers').select('schedule_id').eq('teacher_id', teacherId),
    supabase.from('schedule_overrides').select('schedule_id').eq('sub_teacher_id', teacherId),
  ]);
  const ids = [...new Set([...(co.data || []), ...(sub.data || [])].map(r => r.schedule_id))];
  const viaIds = ids.length ? (await supabase.from('schedules').select('section_id').in('id', ids)).data || [] : [];
  return new Set([...(own.data || []), ...viaIds].map(r => r.section_id));
}

// An attendance log: the reviewer must run the session it belongs to. Logs without a session are admin-only.
async function canOverrideLog(supabase, user, log) {
  if (user?.role === 'admin') return true;
  if (!log.session_id) return false;
  const { data: s } = await supabase.from('class_sessions').select('schedule_id, session_date').eq('id', log.session_id).maybeSingle();
  return !!s && canManageAny(supabase, user, [s.schedule_id], s.session_date);
}

// Does this teacher own, co-teach or substitute (any date) any schedule of the section?
async function teachesSection(teacherId, sectionId) {
  const supabase = require('../supabase'); // lazy: pure helpers above stay loadable without env
  if (!teacherId) return false;
  return (await teacherSectionIds(supabase, teacherId)).has(sectionId);
}

module.exports = { canManageAny, canReviewLeave, teacherSectionIds, canOverrideLog, teachesSection };
