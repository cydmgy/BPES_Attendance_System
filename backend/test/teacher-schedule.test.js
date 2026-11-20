// The teacher portal's timetable logic lives in a plain browser script; it also exports itself for node.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hourLabel, buildWeekGrid, groupTeacherClasses } = require('../../frontend/js/teacher-schedule.js');

const ME = 'teacher-1';
let n = 0;
const sched = (day_of_week, start_time, end_time, extra = {}) => ({
  id: `s${++n}`, day_of_week, start_time, end_time, status: 'active', teacher_id: ME,
  subjects: { name: 'Math' }, sections: { section_name: 'Diamond' }, rooms: { name: 'Room 1' }, ...extra,
});

test('hourLabel: 12-hour style without am/pm', () => {
  assert.equal(hourLabel(7), '7-8');
  assert.equal(hourLabel(11), '11-12');
  assert.equal(hourLabel(12), '12-1');
  assert.equal(hourLabel(13), '1-2');
});

test('buildWeekGrid: days are Monday to Friday, plus Saturday only when a Saturday class exists', () => {
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  assert.deepEqual(buildWeekGrid([sched('Monday', '07:00:00', '08:00:00')], ME).days, weekdays);
  assert.deepEqual(buildWeekGrid([sched('Saturday', '07:00:00', '08:00:00')], ME).days, [...weekdays, 'Saturday']);
});

test('buildWeekGrid: a class that starts at 07:30 and ends 08:15 sits in the 7 and 8 rows with its exact times', () => {
  const grid = buildWeekGrid([sched('Monday', '07:30:00', '08:15:00')], ME);
  assert.deepEqual(grid.hours, [7, 8]);
  for (const h of [7, 8]) {
    assert.equal(grid.cells[h].Monday.length, 1);
    assert.equal(grid.cells[h].Monday[0].start_time, '07:30:00');
    assert.equal(grid.cells[h].Monday[0].end_time, '08:15:00');
  }
  assert.equal(grid.cells[7].Tuesday.length, 0);
});

test('buildWeekGrid: a class ending exactly on the hour does not spill into the next row', () => {
  assert.deepEqual(buildWeekGrid([sched('Monday', '07:00:00', '09:00:00')], ME).hours, [7, 8]);
});

test('buildWeekGrid: a taught class and a co-taught class in the same cell are both listed, with their roles', () => {
  const own = sched('Tuesday', '09:00:00', '10:00:00');
  const co = sched('Tuesday', '09:00:00', '10:00:00', { teacher_id: 'someone-else', sections: { section_name: 'Ruby' } });
  const cell = buildWeekGrid([own, co], ME).cells[9].Tuesday;
  assert.deepEqual(cell.map(e => e.role).sort(), ['co', 'own']);
  assert.deepEqual(cell.map(e => e.section).sort(), ['Diamond', 'Ruby']);
  assert.equal(cell[0].subject, 'Math');
  assert.equal(cell[0].room, 'Room 1');
});

test('buildWeekGrid: hours between two classes are kept as empty rows', () => {
  const grid = buildWeekGrid([sched('Monday', '07:00:00', '08:00:00'), sched('Monday', '10:00:00', '11:00:00')], ME);
  assert.deepEqual(grid.hours, [7, 8, 9, 10]);
  assert.equal(grid.cells[8].Monday.length, 0);
});

test('buildWeekGrid: archived schedules are ignored', () => {
  assert.deepEqual(buildWeekGrid([sched('Monday', '07:00:00', '08:00:00', { status: 'archived' })], ME).hours, []);
});

test('buildWeekGrid: a teacher with no classes gets an empty grid, not an error', () => {
  const grid = buildWeekGrid([], ME);
  assert.deepEqual(grid.hours, []);
  assert.deepEqual(grid.cells, {});
  assert.equal(grid.days.length, 5);
});

test('buildWeekGrid: without a selfId (student view) no entry gets a role', () => {
  const co = sched('Monday', '07:00:00', '08:00:00', { teacher_id: 'someone-else' });
  const entry = buildWeekGrid([sched('Monday', '07:00:00', '08:00:00'), co], null).cells[7].Monday[0];
  assert.equal('role' in entry, false);
  for (const e of buildWeekGrid([co], null).cells[7].Monday) assert.notEqual(e.role, 'co');
});

test('buildWeekGrid: entries carry the teacher name', () => {
  const s = sched('Monday', '07:00:00', '08:00:00', { teacher: { full_name: 'Ana Reyes' } });
  assert.equal(buildWeekGrid([s], null).cells[7].Monday[0].teacher, 'Ana Reyes');
  assert.equal(buildWeekGrid([sched('Monday', '07:00:00', '08:00:00')], ME).cells[7].Monday[0].teacher, '');
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
