const test = require('node:test');
const assert = require('node:assert');
const { cleanSubjectBody } = require('../src/utils/subject');

test('trims name and applies defaults on create', () => {
  const r = cleanSubjectBody({ name: '  Science ' }, { partial: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fields.name, 'Science');
  assert.strictEqual(r.fields.late_threshold_minutes, 15);
});

test('code and min_attendance_percent are no longer subject fields: ignored on create and update', () => {
  const body = { name: ' Math ', code: 'M1', min_attendance_percent: 50 };
  for (const partial of [false, true]) {
    const { fields } = cleanSubjectBody(body, { partial });
    assert.strictEqual('code' in fields, false);
    assert.strictEqual('min_attendance_percent' in fields, false);
  }
  assert.strictEqual(cleanSubjectBody({ code: 'M1' }, { partial: true }).ok, false); // nothing left to update
});

test('rejects a blank name', () => {
  assert.strictEqual(cleanSubjectBody({ name: '   ' }, { partial: false }).ok, false);
});

test('partial update keeps only the given fields', () => {
  const r = cleanSubjectBody({ late_threshold_minutes: '10' }, { partial: true });
  assert.deepStrictEqual(r.fields, { late_threshold_minutes: 10 });
});

test('partial update with nothing is rejected', () => {
  assert.strictEqual(cleanSubjectBody({}, { partial: true }).ok, false);
});

test('partial update rejects a blank name', () => {
  assert.strictEqual(cleanSubjectBody({ name: ' ' }, { partial: true }).ok, false);
});
