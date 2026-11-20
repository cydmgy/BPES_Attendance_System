const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSlot, teacherRole, studentTapStatus, toMinutes } = require('../src/utils/slot');
const { localNow, localIso } = require('../src/utils/time');

const P1 = { id: 'p1', start_time: '08:00:00', end_time: '09:00:00' };
const P2 = { id: 'p2', start_time: '09:00:00', end_time: '10:00:00' };
const P3 = { id: 'p3', start_time: '10:30:00', end_time: '11:30:00' };
const day = [P2, P3, P1]; // unordered on purpose
const at = hhmm => toMinutes(hhmm);

test('resolveSlot: inside a period', () => {
  assert.equal(resolveSlot(day, at('08:30'))?.id, 'p1');
});

test('resolveSlot: 08:50-09:00 belongs to the next back-to-back period', () => {
  assert.equal(resolveSlot(day, at('08:49'))?.id, 'p1');
  assert.equal(resolveSlot(day, at('08:50'))?.id, 'p2');
  assert.equal(resolveSlot(day, at('08:59'))?.id, 'p2');
  assert.equal(resolveSlot(day, at('09:00'))?.id, 'p2');
});

test('resolveSlot: look-ahead before the first period and across a gap', () => {
  assert.equal(resolveSlot(day, at('07:49')), null);
  assert.equal(resolveSlot(day, at('07:50'))?.id, 'p1');
  assert.equal(resolveSlot(day, at('10:10')), null);   // gap 10:00-10:30, too early for p3
  assert.equal(resolveSlot(day, at('10:20'))?.id, 'p3');
});

test('resolveSlot: end is exclusive, nothing after the last period, empty day', () => {
  assert.equal(resolveSlot(day, at('11:30')), null);
  assert.equal(resolveSlot([], at('09:00')), null);
  assert.equal(resolveSlot(undefined, at('09:00')), null);
});

test('resolveSlot works on Manila time across UTC midnight', () => {
  // 2026-11-19 23:55 UTC = 2026-11-20 07:55 Manila (Friday): look-ahead into the 08:00 period
  const n = localNow(new Date('2026-11-19T23:55:00Z'));
  assert.equal(n.dayName, 'Friday');
  assert.equal(resolveSlot(day, n.minutes)?.id, 'p1');
});

test('teacherRole: regular, co-teacher, substitute, stranger', () => {
  const s = { teacher_id: 't1' };
  assert.equal(teacherRole(s, 't1'), 'ongoing');
  assert.equal(teacherRole(s, 't2', { coTeacherIds: ['t2'] }), 'ongoing');
  assert.equal(teacherRole(s, 't3', { subTeacherId: 't3' }), 'substituted');
  assert.equal(teacherRole(s, 't4', { coTeacherIds: ['t2'], subTeacherId: 't3' }), null);
  assert.equal(teacherRole({ teacher_id: null }, 't1'), null);
  assert.equal(teacherRole(null, 't1'), null);
});

test('studentTapStatus: cutoff is MAX(start, teacher arrival) + threshold', () => {
  const startAt = new Date(localIso('2026-11-20', '08:00:00'));
  const t = hhmm => new Date(localIso('2026-11-20', `${hhmm}:00`));
  // teacher on time: late after 08:15
  assert.equal(studentTapStatus({ tapAt: t('08:15'), startAt, teacherTimeIn: t('07:58'), thresholdMinutes: 15 }), 'present');
  assert.equal(studentTapStatus({ tapAt: t('08:16'), startAt, teacherTimeIn: t('07:58'), thresholdMinutes: 15 }), 'late');
  // teacher 10 min late: students get the grace from the teacher's arrival
  assert.equal(studentTapStatus({ tapAt: t('08:24'), startAt, teacherTimeIn: t('08:10'), thresholdMinutes: 15 }), 'present');
  assert.equal(studentTapStatus({ tapAt: t('08:26'), startAt, teacherTimeIn: t('08:10'), thresholdMinutes: 15 }), 'late');
  // no teacher (no_teacher session) and missing threshold -> start + 15 default
  assert.equal(studentTapStatus({ tapAt: t('08:16'), startAt, teacherTimeIn: null, thresholdMinutes: null }), 'late');
});
