const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGradeLevel } = require('../src/utils/section');

test('parseGradeLevel: blank means no grade (null)', () => {
  assert.equal(parseGradeLevel(''), null);
  assert.equal(parseGradeLevel(null), null);
  assert.equal(parseGradeLevel(undefined), null);
});

test('parseGradeLevel: whole numbers 1 to 6, as a number or a numeric string', () => {
  assert.equal(parseGradeLevel('3'), 3);
  assert.equal(parseGradeLevel(6), 6);
  assert.equal(parseGradeLevel(' 1 '), 1);
});

test('parseGradeLevel: anything else is invalid (undefined)', () => {
  for (const bad of [0, 7, -1, 2.5, 'abc', '3x', {}, [], true]) {
    assert.equal(parseGradeLevel(bad), undefined, JSON.stringify(bad));
  }
});
