// POST /api/scan: student taps in/out of an open session, and which duplicate rule answers.
// Runs the real router against a table-aware fake database (never touches Supabase).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.IOT_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';

// What each table returns this test; changed per test through `db`.
const SECTION = 'sec-1';
let db;
const reset = () => {
  db = {
    student: { id: 's1', full_name: 'Juan Dela Cruz', student_id: '123456789012', section_id: SECTION },
    // A period that is always "now", so the test does not depend on the clock.
    schedules: [{ id: 'sch1', section_id: SECTION, start_time: '00:00:00', end_time: '23:59:59', subjects: { late_threshold_minutes: 15 } }],
    session: { id: 'ses1', status: 'ongoing', teacher_time_in: null },
    existingLog: { id: 'log1', status: 'present' }, // row already in the session / inside the guard window
  };
};
reset();

function resolve(table, ops) {
  const inserting = ops.includes('insert');
  switch (table) {
    case 'instructors': case 'no_class_days': return { data: null, error: null };
    case 'students': return { data: db.student, error: null };
    case 'rooms': return { data: { id: 'room1', name: 'Room 101' }, error: null };
    case 'schedules': return { data: db.schedules, error: null };
    case 'class_sessions': return { data: db.session, error: null };
    case 'daily_presence': return { data: null, error: null };
    case 'attendance_logs':
      // Inserting into a session the student is already in hits uq_attendance_session_student.
      if (inserting) return db.existingLog ? { data: null, error: { code: '23505' } } : { data: { id: 'new', status: 'present' }, error: null };
      return { data: db.existingLog, error: null };
    default: return { data: null, error: null };
  }
}
const fake = {
  from(table) {
    const ops = [];
    const q = new Proxy({}, {
      get: (_, k) => {
        if (k === 'then') return ok => ok(resolve(table, ops));
        if (k === 'catch') return undefined;
        if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve(resolve(table, ops));
        return () => { ops.push(k); return q; };
      },
    });
    return q;
  },
  rpc: () => fake.from('rpc'),
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake };

const app = express();
app.use(express.json());
app.use('/api/scan', require('../src/routes/scan'));

let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());
test.beforeEach(reset);

const tap = async () => {
  const res = await fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify({ uid: 'AA BB CC DD', device_id: 'ESP32-DOOR-01' }),
  });
  return { status: res.status, json: await res.json() };
};

test('student already recorded in the open session: 409 carrying the recorded status', async () => {
  db.existingLog = { id: 'log1', status: 'present' };
  const r = await tap();
  assert.equal(r.status, 409);
  assert.equal(r.json.status, 'present');
  assert.equal(r.json.success, false);
  assert.equal(r.json.log_id, 'log1');
});

test('student excused by approved leave taps: 409 with status excused', async () => {
  db.existingLog = { id: 'log2', status: 'excused' };
  const r = await tap();
  assert.equal(r.status, 409);
  assert.equal(r.json.status, 'excused');
});

test('first tap in an open session is logged: 200', async () => {
  db.existingLog = null;
  const r = await tap();
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'present');
  assert.equal(r.json.log_id, 'new');
});

test('student tap with no open session: 200 no_session and nothing logged', async () => {
  db.session = null;
  const r = await tap();
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'no_session');
  assert.equal(r.json.log_id, null);
});

test('unknown card tapped again inside the guard window: still 409', async () => {
  db.student = null;
  db.existingLog = { id: 'u1', timestamp: new Date().toISOString() };
  const r = await tap();
  assert.equal(r.status, 409);
  assert.match(r.json.message, /Duplicate scan/);
});
