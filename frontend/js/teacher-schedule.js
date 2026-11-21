// Teacher schedule views: pure functions over the rows of GET /api/schedules/my-week.
// A plain browser script (window.TeacherSchedule) that also exports itself for node tests.
(function (root) {
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  const minutes = t => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };

  // Hour-line label (24h in): 7 -> '7 AM', 12 -> '12 PM', 13 -> '1 PM', 0 -> '12 AM'.
  const timeLabel = hour => `${hour % 12 || 12} ${hour % 24 < 12 ? 'AM' : 'PM'}`;

  // Calendar-style week: one block per class at its real time. `top`/`height` are minutes from `start`
  // (the earliest start floored to the hour; `end` is the latest end ceiled). Classes that overlap share a
  // cluster and sit in side-by-side lanes; touching ones (a.end === b.start) do not overlap.
  // One-off substitutions are not part of it.
  function buildWeekCalendar(schedules, selfId) {
    const active = (schedules || []).filter(s => s.status === 'active' && [...WEEKDAYS, 'Saturday'].includes(s.day_of_week));
    const days = active.some(s => s.day_of_week === 'Saturday') ? [...WEEKDAYS, 'Saturday'] : WEEKDAYS.slice();
    const blocks = Object.fromEntries(days.map(d => [d, []]));
    if (!active.length) return { days, start: null, end: null, hours: [], blocks };

    const start = Math.floor(Math.min(...active.map(s => minutes(s.start_time))) / 60) * 60;
    const end = Math.ceil(Math.max(...active.map(s => minutes(s.end_time))) / 60) * 60;
    const hours = [];
    for (let h = start / 60; h < end / 60; h++) hours.push(h);

    for (const s of active) {
      const block = {
        schedule_id: s.id,
        subject: s.subjects?.name || '—',
        section: s.sections?.section_name || '',
        room: s.rooms?.name || '—',
        start_time: s.start_time,
        end_time: s.end_time,
        teacher: s.teacher?.full_name || '',
        top: minutes(s.start_time) - start,
        height: minutes(s.end_time) - minutes(s.start_time),
        lane: 0,
        lanes: 1,
      };
      if (selfId != null) block.role = s.teacher_id === selfId ? 'own' : 'co'; // students have no 'self'
      blocks[s.day_of_week].push(block);
    }

    for (const day of days) {
      const list = blocks[day].sort((a, b) => a.top - b.top || a.height - b.height);
      let cluster = [], laneEnds = [], clusterEnd = -1;
      const close = () => { for (const b of cluster) b.lanes = laneEnds.length; cluster = []; laneEnds = []; };
      for (const b of list) {
        if (b.top >= clusterEnd) { close(); clusterEnd = -1; }
        b.lane = laneEnds.findIndex(e => e <= b.top);
        if (b.lane < 0) b.lane = laneEnds.length;
        laneEnds[b.lane] = b.top + b.height;
        clusterEnd = Math.max(clusterEnd, b.top + b.height);
        cluster.push(b);
      }
      close();
    }
    return { days, start, end, hours, blocks };
  }

  const DAY_ORDER = [...WEEKDAYS, 'Saturday'];

  // "My Classes": what a teacher handles, as Grade > Section > Subject with each subject's weekly slots.
  // Grades ascend with "no grade" (null) last; teaching a subject at all makes the role 'own', otherwise 'co'.
  function groupTeacherClasses(schedules, selfId) {
    const grades = new Map(); // grade -> Map(section_id -> section)
    for (const s of schedules || []) {
      if (s.status !== 'active') continue;
      const grade = s.sections?.grade_level ?? null;
      const sectionId = s.section_id || s.sections?.id;
      const subjectId = s.subject_id || s.subjects?.id;
      if (!grades.has(grade)) grades.set(grade, new Map());
      const sections = grades.get(grade);
      if (!sections.has(sectionId)) sections.set(sectionId, { section_id: sectionId, section_name: s.sections?.section_name || '', subjects: new Map() });
      const subjects = sections.get(sectionId).subjects;
      if (!subjects.has(subjectId)) subjects.set(subjectId, { subject_id: subjectId, name: s.subjects?.name || '—', role: 'co', slots: [] });
      const subject = subjects.get(subjectId);
      if (s.teacher_id === selfId) subject.role = 'own';
      subject.slots.push({ day: s.day_of_week, start_time: s.start_time, end_time: s.end_time, room: s.rooms?.name || '—' });
    }

    const byName = key => (a, b) => a[key].localeCompare(b[key]);
    const bySlot = (a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.start_time.localeCompare(b.start_time);
    return [...grades.entries()]
      .sort(([a], [b]) => (a === null) - (b === null) || a - b)
      .map(([grade, sections]) => ({
        grade,
        sections: [...sections.values()].sort(byName('section_name')).map(sec => ({
          ...sec,
          subjects: [...sec.subjects.values()].sort(byName('name')).map(sub => ({ ...sub, slots: sub.slots.sort(bySlot) })),
        })),
      }));
  }

  const api = { timeLabel, buildWeekCalendar, groupTeacherClasses };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TeacherSchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
