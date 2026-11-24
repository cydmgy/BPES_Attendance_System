// Regression tests for two security fixes. Real teachers router, fake database (no Supabase, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

// `answer(table, ops)` -> { data, error }; `writes` records every insert/update/upsert payload.
let answer, writes;
const fake = {
  from(table) {
    const ops = [];
    const done = () => Promise.resolve(answer(table, ops));
    const q = new Proxy({}, {
      get: (_, k) => {
        if (k === 'then') return ok => done().then(ok);
        if (k === 'catch') return undefined;
        if (k === 'single' || k === 'maybeSingle') return () => { ops.push({ k }); return done(); };
        return (...args) => { ops.push({ k, args }); if (['insert', 'update', 'upsert'].includes(k)) writes.push({ table, k, payload: args[0] }); return q; };
      },
    });
    return q;
  },
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake };

const { generateToken } = require('../src/utils/token');
const TEACHER = '55555555-5555-5555-5555-555555555555';
const tokens = {
  admin: generateToken({ id: '00000000-0000-0000-0000-000000000000', role: 'admin' }),
  teacher: generateToken({ id: TEACHER, instructor_id: TEACHER, role: 'instructor' }),
};

const app = express();
app.use(express.json());
app.use('/api/teachers', require('../src/routes/teachers'));

let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());
test.beforeEach(() => { writes = []; answer = () => ({ data: null, error: null }); });

const call = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[token]}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const has = (ops, k) => ops.some(o => o.k === k);
const updatedTeacher = (table, ops) => has(ops, 'update') && table === 'instructors'
  ? { data: { id: TEACHER, full_name: 'Ms T' }, error: null } : { data: null, error: null };
const wroteHash = () => writes.some(w => w.payload && 'password_hash' in w.payload);

test('a teacher cannot set a new password through PUT /api/teachers/:id (403, nothing written)', async () => {
  answer = updatedTeacher;
  const r = await call('PUT', `/api/teachers/${TEACHER}`, 'teacher', { password: 'brandnew1' });
  assert.equal(r.status, 403);
  assert.equal(wroteHash(), false);
});

test('an admin can still reset a teacher password through PUT (6+ characters)', async () => {
  answer = updatedTeacher;
  const r = await call('PUT', `/api/teachers/${TEACHER}`, 'admin', { password: 'brandnew1' });
  assert.equal(r.status, 200);
  assert.equal(wroteHash(), true);
});

test('creating a teacher is refused, not saved, when the card-clash lookup itself fails', async () => {
  answer = (table, ops) => has(ops, 'insert') ? { data: { id: TEACHER, full_name: 'Ms T' }, error: null }
    : { data: null, error: { code: 'XX000', message: 'db down' } };
  const r = await call('POST', '/api/teachers', 'admin', { full_name: 'Ms T', email: 'T@school.test', rfid_uid: 'AA:BB:CC:DD' });
  assert.notEqual(r.status, 201);
  assert.equal(writes.some(w => w.table === 'instructors' && w.k === 'insert'), false);
});

test('an admin password under 6 characters is a 400, not a silent 200', async () => {
  answer = updatedTeacher;
  const r = await call('PUT', `/api/teachers/${TEACHER}`, 'admin', { full_name: 'Ms T', password: 'abc' });
  assert.equal(r.status, 400);
  assert.equal(writes.length, 0);
});
