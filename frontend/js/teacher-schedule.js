// Teacher schedule views: pure functions over the rows of GET /api/schedules/my-week.
// A plain browser script (window.TeacherSchedule) that also exports itself for node tests.
(function (root) {
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  const minutes = t => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };

  // Row label for the hour starting at `hour` (24h): 7 -> '7-8', 12 -> '12-1', 13 -> '1-2'.
  const hourLabel = hour => `${hour % 12 || 12}-${(hour + 1) % 12 || 12}`;

  // Weekly timetable grid: rows are hours, columns are days. A class appears in every hour row it overlaps,
  // so 07:30-08:15 sits in the 7 and 8 rows (its exact times stay on the entry). One-off substitutions are not part of it.
  function buildWeekGrid(schedules, selfId) {
    const active = (schedules || []).filter(s => s.status === 'active' && [...WEEKDAYS, 'Saturday'].includes(s.day_of_week));
    const days = active.some(s => s.day_of_week === 'Saturday') ? [...WEEKDAYS, 'Saturday'] : WEEKDAYS.slice();
    if (!active.length) return { days, hours: [], cells: {} };

    const first = Math.min(...active.map(s => Math.floor(minutes(s.start_time) / 60)));
    const last = Math.max(...active.map(s => Math.ceil(minutes(s.end_time) / 60) - 1));
    const hours = [];
    const cells = {};
    for (let h = first; h <= last; h++) {
      hours.push(h);
      cells[h] = Object.fromEntries(days.map(d => [d, []]));
    }

    for (const s of active) {
      const entry = {
        schedule_id: s.id,
        subject: s.subjects?.name || '—',
        section: s.sections?.section_name || '',
        room: s.rooms?.name || '—',
        start_time: s.start_time,
        end_time: s.end_time,
        teacher: s.teacher?.full_name || '',
      };
      if (selfId != null) entry.role = s.teacher_id === selfId ? 'own' : 'co'; // students have no 'self'
      for (let h = Math.floor(minutes(s.start_time) / 60); h <= Math.ceil(minutes(s.end_time) / 60) - 1; h++) {
        cells[h][s.day_of_week].push(entry);
      }
    }
    for (const h of hours) for (const d of days) cells[h][d].sort((a, b) => a.start_time.localeCompare(b.start_time));
    return { days, hours, cells };
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

  const api = { hourLabel, buildWeekGrid, groupTeacherClasses };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TeacherSchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
