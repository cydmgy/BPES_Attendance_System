const test = require('node:test');
const assert = require('node:assert/strict');
const { LEAVE_TYPES, leaveCoversPeriod, leaveTypesConflict } = require('../src/utils/leave');

const period = (start_time, subject_id = 'math') => ({ subject_id, start_time });
const leave = (leave_type, subject_id = null) => ({ leave_type, subject_id });

test('LEAVE_TYPES lists the three types a request may carry', () => {
  assert.deepEqual(LEAVE_TYPES, ['whole_day', 'half_day_am', 'half_day_pm']);
});

test('a whole day covers every period', () => {
  assert.equal(leaveCoversPeriod(leave('whole_day'), period('07:30:00')), true);
  assert.equal(leaveCoversPeriod(leave('whole_day'), period('15:00:00')), true);
});

test('morning covers periods starting before 12:00, afternoon the rest (12:00:00 is afternoon)', () => {
  assert.equal(leaveCoversPeriod(leave('half_day_am'), period('11:59:00')), true);
  assert.equal(leaveCoversPeriod(leave('half_day_am'), period('12:00:00')), false);
  assert.equal(leaveCoversPeriod(leave('half_day_pm'), period('11:59:00')), false);
  assert.equal(leaveCoversPeriod(leave('half_day_pm'), period('12:00:00')), true);
});

test('an old request that names a subject still covers only that subject', () => {
  assert.equal(leaveCoversPeriod(leave('whole_day', 'math'), period('08:00:00', 'math')), true);
  assert.equal(leaveCoversPeriod(leave('whole_day', 'math'), period('09:00:00', 'sci')), false);
});

test('leaveTypesConflict: a whole day clashes with anything, a half day only with the same half', () => {
  assert.equal(leaveTypesConflict('whole_day', 'half_day_am'), true);
  assert.equal(leaveTypesConflict('half_day_pm', 'whole_day'), true);
  assert.equal(leaveTypesConflict('half_day_am', 'half_day_am'), true);
  assert.equal(leaveTypesConflict('half_day_am', 'half_day_pm'), false);
});
