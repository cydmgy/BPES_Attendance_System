const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNoClassDay, noClassBody } = require('../src/utils/noClassDay');

const TODAY = '2026-11-20';

test('a valid future day and reason parse, reason trimmed', () => {
  assert.deepEqual(parseNoClassDay({ day: '2026-11-25', reason: '  Typhoon  ' }, TODAY), { day: '2026-11-25', reason: 'Typhoon' });
});

test('today is allowed', () => {
  assert.equal(parseNoClassDay({ day: TODAY, reason: 'Holiday' }, TODAY).day, TODAY);
});

test('bad formats and impossible dates are rejected', () => {
  for (const day of [undefined, '', '2026-1-5', '25/11/2026', '2026-02-30', '2026-13-01', 20261125, '2026-11-25T00:00']) {
    assert.ok(parseNoClassDay({ day, reason: 'x' }, TODAY).error, String(day));
  }
});

test('empty or whitespace reason is rejected', () => {
  for (const reason of [undefined, '', '   ', null]) {
    assert.ok(parseNoClassDay({ day: '2026-11-25', reason }, TODAY).error, String(reason));
  }
});

test('a day before today is rejected', () => {
  assert.ok(parseNoClassDay({ day: '2026-11-19', reason: 'x' }, TODAY).error);
});

test('noClassBody is the 200 body readers see on a no-class day (never 409, which means duplicate)', () => {
  assert.deepEqual(noClassBody('Typhoon'), { success: false, role: 'none', status: 'no_class', reason: 'Typhoon' });
  assert.equal(noClassBody(undefined).reason, null);
});
