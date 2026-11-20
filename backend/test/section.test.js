const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGradeLevel, countBySection } = require('../src/utils/section');

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

test('countBySection: students per section name, natural order, students without a section skipped', () => {
  const rows = [
    { sections: { section_name: 'Grade 10 - Ruby' } }, { sections: { section_name: 'Grade 2 - Pearl' } },
    { sections: { section_name: 'Grade 2 - Pearl' } }, { sections: null }, {}, 7,
  ];
  assert.deepEqual(countBySection(rows), [{ section: 'Grade 2 - Pearl', count: 2 }, { section: 'Grade 10 - Ruby', count: 1 }]);
  assert.deepEqual(countBySection([]), []);
  assert.deepEqual(countBySection(undefined), []);
});
