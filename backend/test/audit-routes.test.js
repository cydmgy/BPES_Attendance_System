// Mutating routes write one audit_log row each, against an in-process fake Supabase client.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';

const audits = [];
const ROW = { id: 'r1', full_name: 'Juan Dela Cruz', name: 'Room 1', email: 'j@x.ph' };
// A delete chain returns the deleted row. Any table chains; audit_log inserts are recorded; single/maybeSingle yield ROW, awaiting a chain yields [].
const fake = {
  from: (table) => {
    let deleting = false;
    const q = new Proxy({}, { get: (_, k) => {
      if (k === 'insert' && table === 'audit_log') return row => (audits.push(row), Promise.resolve({ error: null }));
      if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve({ data: ROW, error: null });
      if (k === 'then') return ok => ok({ data: deleting ? [ROW] : [], error: null });
      return (...a) => (k === 'delete' && (deleting = true), q);
    } });
    return q;
  },
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake };

const { generateToken } = require('../src/utils/token');
const ADMIN = { id: '00000000-0000-0000-0000-000000000000', username: 'admin', role: 'admin' };
const app = express();
app.use(express.json());
app.use('/api/students', require('../src/routes/students'));
app.use('/api/teachers', require('../src/routes/teachers'));
app.use('/api/no-class-days', require('../src/routes/noClassDays'));
app.use('/api/rooms', require('../src/routes/rooms'));
let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const call = async (method, path, body) => {
  audits.length = 0;
  const res = await fetch(base + path, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${generateToken(ADMIN)}`, 'content-type': 'application/json' },
  });
  return res.status;
};

test('PUT /api/students/:id audits one update without the PIN', async () => {
  assert.equal(await call('PUT', '/api/students/r1', { full_name: 'Juan Dela Cruz', pin: '987654' }), 200);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].entity, 'student');
  assert.equal(audits[0].action, 'update');
  assert.match(audits[0].summary, /Juan Dela Cruz/);
  assert.doesNotMatch(audits[0].summary, /987654/);
});

test('DELETE /api/no-class-days/:day audits one delete', async () => {
  assert.equal(await call('DELETE', '/api/no-class-days/2026-12-25'), 200);
  assert.deepEqual(audits.map(a => [a.entity, a.action, a.entity_id]), [['no_class_day', 'delete', '2026-12-25']]);
});

test('teacher update with a password never puts it in the summary', async () => {
  assert.equal(await call('PUT', '/api/teachers/r1', { full_name: 'Juan Dela Cruz', password: 'SuperSecret1' }), 200);
  assert.equal(audits.length, 1);
  assert.deepEqual([audits[0].entity, audits[0].action], ['teacher', 'update']);
  assert.doesNotMatch(audits[0].summary, /SuperSecret1/);
});

test('teacher reset-password is audited as reset_password, and room create as create', async () => {
  assert.equal(await call('POST', '/api/teachers/r1/reset-password'), 200);
  assert.deepEqual([audits[0].entity, audits[0].action], ['teacher', 'reset_password']);
  assert.equal(await call('POST', '/api/rooms', { name: 'Room 1' }), 201);
  assert.deepEqual([audits[0].entity, audits[0].action], ['room', 'create']);
});

test('DELETE /api/students/:id names the deleted student in the summary', async () => {
  assert.equal(await call('DELETE', '/api/students/r1'), 200);
  assert.deepEqual([audits[0].entity, audits[0].action], ['student', 'delete']);
  assert.match(audits[0].summary, /Juan Dela Cruz/);
});
