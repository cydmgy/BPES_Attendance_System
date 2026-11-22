const test = require('node:test');
const assert = require('node:assert/strict');
const { freeWindows, to12h } = require('../../frontend/js/schedule-slots.js');

const w = (start, end) => ({ start, end });

test('empty day is one full window', () => {
  assert.deepEqual(freeWindows([]), [w('07:00', '16:00')]);
});

test('busy 07-14 and 15-16 leaves 14-15', () => {
  assert.deepEqual(freeWindows([w('07:00', '14:00'), w('15:00', '16:00')]), [w('14:00', '15:00')]);
});

test('back-to-back ranges merge and leave the outer gaps', () => {
  assert.deepEqual(freeWindows([w('08:00', '09:00'), w('09:00', '10:00')]), [w('07:00', '08:00'), w('10:00', '16:00')]);
});

test('overlapping ranges merge', () => {
  assert.deepEqual(freeWindows([w('08:00', '10:00'), w('09:00', '11:00')]), [w('07:00', '08:00'), w('11:00', '16:00')]);
});

test('ranges outside the day are clamped', () => {
  assert.deepEqual(freeWindows([w('06:00', '08:00'), w('15:00', '17:00')]), [w('08:00', '15:00')]);
});

test('fully busy day has no windows', () => {
  assert.deepEqual(freeWindows([w('06:00', '17:00')]), []);
});

test('HH:MM:SS input is accepted', () => {
  assert.deepEqual(freeWindows([w('08:00:00', '09:30:00')]), [w('07:00', '08:00'), w('09:30', '16:00')]);
});

test('unsorted input is handled', () => {
  assert.deepEqual(freeWindows([w('13:00', '14:00'), w('08:00', '09:00')]),
    [w('07:00', '08:00'), w('09:00', '13:00'), w('14:00', '16:00')]);
});

test('zero-length and inverted ranges are ignored', () => {
  assert.deepEqual(freeWindows([w('09:00', '09:00'), w('11:00', '10:00')]), [w('07:00', '16:00')]);
});

test('custom day bounds', () => {
  assert.deepEqual(freeWindows([w('09:00', '10:00')], '08:00', '12:00'), [w('08:00', '09:00'), w('10:00', '12:00')]);
});

test('to12h formats clock times', () => {
  assert.equal(to12h('14:00'), '2:00 PM');
  assert.equal(to12h('07:30'), '7:30 AM');
  assert.equal(to12h('12:00'), '12:00 PM');
  assert.equal(to12h('00:00'), '12:00 AM');
  assert.equal(to12h('16:00:00'), '4:00 PM');
});
