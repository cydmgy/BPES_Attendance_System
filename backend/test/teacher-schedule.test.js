// The teacher portal's timetable logic lives in a plain browser script; it also exports itself for node.
const test = require('node:test');
const assert = require('node:assert/strict');
const { timeLabel, buildWeekCalendar, groupTeacherClasses } = require('../../frontend/js/teacher-schedule.js');

const ME = 'teacher-1';
let n = 0;
const sched = (day_of_week, start_time, end_time, extra = {}) => ({
  id: `s${++n}`, day_of_week, start_time, end_time, status: 'active', teacher_id: ME,
  subjects: { name: 'Math' }, sections: { section_name: 'Diamond' }, rooms: { name: 'Room 1' }, ...extra,
});

test('timeLabel', () => { assert.equal(timeLabel(7), '7 AM'); assert.equal(timeLabel(12), '12 PM'); assert.equal(timeLabel(13), '1 PM'); assert.equal(timeLabel(0), '12 AM'); });

test('buildWeekCalendar: a 07:30-08:15 class is one block placed at its real time', () => {
  const cal = buildWeekCalendar([sched('Monday', '07:30:00', '08:15:00')], ME);
  assert.equal(cal.start, 420); assert.equal(cal.end, 540); assert.deepEqual(cal.hours, [7, 8]);
  assert.equal(cal.blocks.Monday.length, 1);
  assert.deepEqual([cal.blocks.Monday[0].top, cal.blocks.Monday[0].height], [30, 45]);
  assert.deepEqual(cal.blocks.Tuesday, []);
});

test('buildWeekCalendar: back-to-back classes share one lane', () => {
  const b = buildWeekCalendar([sched('Monday', '07:30:00', '08:15:00'), sched('Monday', '08:15:00', '09:00:00')], ME).blocks.Monday;
  assert.deepEqual(b.map(x => [x.lane, x.lanes]), [[0, 1], [0, 1]]);
});

test('buildWeekCalendar: overlapping classes get side-by-side lanes', () => {
  const own = sched('Tuesday', '09:00:00', '10:00:00');
  const co = sched('Tuesday', '09:30:00', '10:30:00', { teacher_id: 'other' });
  const b = buildWeekCalendar([own, co], ME).blocks.Tuesday;
  assert.deepEqual(b.map(x => [x.lane, x.lanes, x.role]), [[0, 2, 'own'], [1, 2, 'co']]);
});

test('buildWeekCalendar: range is floored/ceiled to whole hours', () => {
  const cal = buildWeekCalendar([sched('Monday', '07:30:00', '09:10:00')], ME);
  assert.deepEqual([cal.start, cal.end, cal.hours], [420, 600, [7, 8, 9]]);
});

test('buildWeekCalendar: empty, archived-only, Saturday and student (no role) cases', () => {
  const empty = buildWeekCalendar([], ME);
  assert.deepEqual([empty.start, empty.hours, empty.days.length], [null, [], 5]);
  assert.deepEqual(buildWeekCalendar([sched('Monday', '07:00:00', '08:00:00', { status: 'archived' })], ME).hours, []);
  assert.equal(buildWeekCalendar([sched('Saturday', '07:00:00', '08:00:00')], ME).days.at(-1), 'Saturday');
  assert.equal('role' in buildWeekCalendar([sched('Monday', '07:00:00', '08:00:00')], null).blocks.Monday[0], false);
});

test('buildWeekCalendar: a later class reuses lane 0 once the cluster has ended, and blocks carry teacher and sort by start', () => {
  const s = sched('Monday', '09:00:00', '10:00:00', { teacher: { full_name: 'Ana Reyes' } });
  const b = buildWeekCalendar([s, sched('Monday', '07:00:00', '08:00:00'), sched('Monday', '07:30:00', '08:30:00')], ME).blocks.Monday;
  assert.deepEqual(b.map(x => [x.start_time, x.lane, x.lanes]), [['07:00:00', 0, 2], ['07:30:00', 1, 2], ['09:00:00', 0, 1]]);
  assert.equal(b[2].teacher, 'Ana Reyes');
});

test('buildWeekCalendar: a chain of overlaps (A-B, B-C, not A-C) is one cluster of 2 lanes, lane 0 reused by C', () => {
  const b = buildWeekCalendar([sched('Monday', '07:00:00', '08:00:00'), sched('Monday', '07:30:00', '08:30:00'), sched('Monday', '08:15:00', '09:00:00')], ME).blocks.Monday;
  assert.deepEqual(b.map(x => x.lane), [0, 1, 0]);
  assert.deepEqual(b.map(x => x.lanes), [2, 2, 2]);
});

// ── My Classes: grade > section > subject ───────────────────────────────
const cls = (day, start, end, { section = ['sec-a', 'Diamond', 3], subject = ['sub-m', 'Math'], teacher_id = ME, room = 'Room 1', status = 'active' } = {}) => ({
  id: `c${++n}`, day_of_week: day, start_time: start, end_time: end, status, teacher_id,
  section_id: section[0], subject_id: subject[0],
  sections: { id: section[0], section_name: section[1], grade_level: section[2] },
  subjects: { id: subject[0], name: subject[1] },
  rooms: { name: room },
});

test('groupTeacherClasses: grades ascending, then sections by name, then subjects by name', () => {
  const out = groupTeacherClasses([
    cls('Monday', '07:00:00', '08:00:00', { section: ['s5', 'Ruby', 5] }),
    cls('Monday', '08:00:00', '09:00:00', { section: ['s3b', 'Pearl', 3], subject: ['sub-s', 'Science'] }),
    cls('Monday', '09:00:00', '10:00:00', { section: ['s3a', 'Diamond', 3], subject: ['sub-m', 'Math'] }),
    cls('Tuesday', '09:00:00', '10:00:00', { section: ['s3a', 'Diamond', 3], subject: ['sub-e', 'English'] }),
  ], ME);
  assert.deepEqual(out.map(g => g.grade), [3, 5]);
  assert.deepEqual(out[0].sections.map(s => s.section_name), ['Diamond', 'Pearl']);
  assert.deepEqual(out[0].sections[0].subjects.map(s => s.name), ['English', 'Math']);
  assert.equal(out[0].sections[0].section_id, 's3a');
  assert.equal(out[0].sections[0].subjects[0].subject_id, 'sub-e');
});

test('groupTeacherClasses: a section with no grade goes last, under grade null', () => {
  const out = groupTeacherClasses([
    cls('Monday', '07:00:00', '08:00:00', { section: ['sx', 'Mystery', null] }),
    cls('Monday', '08:00:00', '09:00:00', { section: ['s6', 'Emerald', 6] }),
  ], ME);
  assert.deepEqual(out.map(g => g.grade), [6, null]);
});

test('groupTeacherClasses: the same subject on two days is one subject with its slots in week order', () => {
  const out = groupTeacherClasses([
    cls('Wednesday', '10:00:00', '11:00:00'),
    cls('Monday', '09:00:00', '10:00:00'),
    cls('Monday', '07:00:00', '08:00:00'),
  ], ME);
  const subject = out[0].sections[0].subjects;
  assert.equal(subject.length, 1);
  assert.deepEqual(subject[0].slots.map(x => `${x.day} ${x.start_time}`), ['Monday 07:00:00', 'Monday 09:00:00', 'Wednesday 10:00:00']);
  assert.equal(subject[0].slots[0].room, 'Room 1');
  assert.equal(subject[0].slots[0].end_time, '08:00:00');
});

test('groupTeacherClasses: teaching a subject and co-teaching it in the same section counts as own', () => {
  const out = groupTeacherClasses([
    cls('Monday', '07:00:00', '08:00:00', { teacher_id: 'someone-else' }),
    cls('Tuesday', '07:00:00', '08:00:00'),
  ], ME);
  assert.equal(out[0].sections[0].subjects[0].role, 'own');
  assert.equal(groupTeacherClasses([cls('Monday', '07:00:00', '08:00:00', { teacher_id: 'someone-else' })], ME)[0].sections[0].subjects[0].role, 'co');
});

test('groupTeacherClasses: archived rows are ignored, and no classes gives an empty list', () => {
  assert.deepEqual(groupTeacherClasses([cls('Monday', '07:00:00', '08:00:00', { status: 'archived' })], ME), []);
  assert.deepEqual(groupTeacherClasses([], ME), []);
});
