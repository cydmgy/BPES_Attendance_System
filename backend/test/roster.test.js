// GET /api/sections/:id/students: teacher-safe roster, against an in-process fake Supabase client.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';

const SEC = '11111111-1111-4111-8111-111111111111';
const EMPTY = '22222222-2222-4222-8222-222222222222';
const SCHED = '33333333-3333-4333-8333-333333333333';
const db = {
  schedules: [{ id: SCHED, section_id: SEC, teacher_id: 'owner' }],
  schedule_co_teachers: [{ schedule_id: SCHED, teacher_id: 'co' }],
  schedule_overrides: [{ schedule_id: SCHED, sub_teacher_id: 'sub' }],
  students: [
    { id: 's2', full_name: 'Zed', student_id: '2', section_id: SEC, pin: 'x', rfid_uid: 'u2' },
    { id: 's1', full_name: 'Ana', student_id: '1', section_id: SEC, pin: 'x', rfid_uid: 'u1' },
  ],
};
// Tiny chainable fake: eq/in filter rows, select(cols) keeps only those columns, order sorts, await resolves.
const fake = {
  from: table => {
    let rows = db[table].slice(), keys;
    const q = {
      select: cols => ((keys = cols.split(',').map(s => s.trim())), q), // projection applied on await, after filters
      eq: (c, v) => (rows = rows.filter(r => r[c] === v), q),
      in: (c, v) => (rows = rows.filter(r => v.includes(r[c])), q),
      order: c => (rows.sort((a, b) => String(a[c]).localeCompare(b[c])), q),
      limit: () => q,
      then: ok => ok({ data: keys ? rows.map(r => Object.fromEntries(keys.map(c => [c, r[c]]))) : rows, error: null }),
    };
    return q;
  },
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake };

const { generateToken } = require('../src/utils/token');
const app = express();
app.use('/api/sections', require('../src/routes/sections'));
let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const who = {
  admin: { id: 'a', role: 'admin' },
  owner: { id: 'owner', instructor_id: 'owner', role: 'instructor' },
  co: { id: 'co', instructor_id: 'co', role: 'instructor' },
  sub: { id: 'sub', instructor_id: 'sub', role: 'instructor' },
  other: { id: 'other', instructor_id: 'other', role: 'instructor' },
  student: { id: 'st', student_id: 'st', role: 'student' },
};
const get = async (id, user) => {
  const res = await fetch(`${base}/api/sections/${id}/students`, { headers: { authorization: `Bearer ${generateToken(who[user])}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('assigned teacher gets names only, ordered by name', async () => {
  const r = await get(SEC, 'owner');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [{ id: 's1', full_name: 'Ana', student_id: '1' }, { id: 's2', full_name: 'Zed', student_id: '2' }]);
  assert.ok(r.json.every(s => !('pin' in s) && !('rfid_uid' in s)));
});

test('co-teacher, substitute and admin are allowed', async () => {
  for (const u of ['co', 'sub', 'admin']) assert.equal((await get(SEC, u)).status, 200, u);
});

test('unassigned teacher and student get 403', async () => {
  assert.equal((await get(SEC, 'other')).status, 403);
  assert.equal((await get(SEC, 'student')).status, 403);
});

test('empty section returns [] and a bad id is 400', async () => {
  assert.deepEqual((await get(EMPTY, 'admin')).json, []);
  assert.equal((await get('nope', 'admin')).status, 400);
});
