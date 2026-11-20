const test = require('node:test');
const assert = require('node:assert/strict');
const { likeEscape, orSafe } = require('../src/utils/filter');

test('likeEscape: wildcards match themselves', () => {
  assert.equal(likeEscape('%'), '\\%');
  assert.equal(likeEscape('a_b'), 'a\\_b');
  assert.equal(likeEscape("O'Brien"), "O'Brien");
});

test('orSafe: cannot add or nest filter conditions', () => {
  const out = orSafe('x,student_id.eq.1)');
  assert.ok(!/[,()]/.test(out));
});

test('orSafe: "Last, First" still matches (the comma becomes a single-character wildcard)', () => {
  assert.equal(orSafe('Cruz, Juan'), 'Cruz_ Juan');
});
