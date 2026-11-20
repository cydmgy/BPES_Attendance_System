const test = require('node:test');
const assert = require('node:assert/strict');
const { countStatuses, attendancePercent, aggregateByStudent, addDays, monthRange, studentBadge } = require('../src/utils/report');

test('studentBadge: log wins, otherwise follows the session state', () => {
  assert.equal(studentBadge({ status: 'ongoing' }, 'late'), 'late');
  assert.equal(studentBadge(null, null), 'upcoming');
  assert.equal(studentBadge({ status: 'pending' }, null), 'upcoming');
  assert.equal(studentBadge({ status: 'ongoing' }, null), 'not_checked_in');
  assert.equal(studentBadge({ status: 'substituted' }, null), 'not_checked_in');
  assert.equal(studentBadge({ status: 'no_teacher' }, null), 'no_teacher');
  assert.equal(studentBadge({ status: 'closed', teacher_time_in: null }, null), 'no_teacher');
  assert.equal(studentBadge({ status: 'closed', teacher_time_in: '2026-11-20T00:02:00Z' }, null), 'absent');
});

const row = (student_id, status) => ({ student_id, status, student: { id: student_id } });

test('countStatuses ignores unknown and missing statuses', () => {
  const c = countStatuses([row('a', 'present'), row('a', 'late'), row('a', 'unknown'), row('b', 'absent'), row('b', 'excused')]);
  assert.deepEqual(c, { present: 1, late: 1, excused: 1, absent: 1, total: 4 });
});

test('attendancePercent: (present + late + excused) / sessions, null when no sessions', () => {
  assert.equal(attendancePercent({ present: 2, late: 1, excused: 1, absent: 1, total: 5 }), 80);
  assert.equal(attendancePercent({ present: 0, late: 0, excused: 0, absent: 0, total: 0 }), null);
});

test('aggregateByStudent: per-student sessions, never above 100%', () => {
  // Several periods a day used to be counted against "school days" and could exceed 100%.
  const rows = [
    row('a', 'present'), row('a', 'present'), row('a', 'late'), row('a', 'present'), row('a', 'present'), row('a', 'present'),
    row('b', 'absent'), row('b', 'absent'), row('b', 'excused'),
    row(null, 'present'),        // unknown card: no student
  ];
  const byId = Object.fromEntries(aggregateByStudent(rows).map(r => [r.student.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'b']);
  assert.equal(byId.a.sessions, 6);
  assert.equal(byId.a.attendance_percent, 100);
  assert.equal(byId.b.absent, 2);
  assert.equal(byId.b.attendance_percent, 33);   // a student who never tapped still appears (absent rows)
});

test('addDays and monthRange are plain calendar math', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(monthRange(2026, 2), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange(2028, 2), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(monthRange(2026, 11), { from: '2026-11-01', to: '2026-11-30' });
});
