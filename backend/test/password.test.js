// Default student password, and the admin routes that set it, against a small stateful fake database.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { defaultStudentPassword: dp } = require('../src/utils/password');

test('defaultStudentPassword: surname + last 4 of the LRN, lowercase, letters only', () => {
  assert.equal(dp('Dela Cruz, Juan A.', '123456789012'), 'delacruz9012');
  assert.equal(dp('Reyes Maria L.', '123456789012'), 'reyes9012');
  assert.equal(dp('Ñoño Peña', '123456789012'), 'nono9012');
  assert.equal(dp('Dela-Cruz, Juan', '123456789012'), 'delacruz9012');
  assert.equal(dp('Cher', '123456789012'), 'cher9012');
  assert.throws(() => dp('Reyes Maria', '12'));
});

const tables = { students: [], instructors: [], sections: [{ id: '22222222-2222-2222-2222-222222222222', section_name: 'Grade 1-A' }], guardians: [], audit_log: [] };
const fakeDb = {
  from: table => {
    let op = 'select', patch, filters = [], inserted;
    const rows = () => tables[table].filter(r => filters.every(f => f(r)));
    const q = new Proxy({}, {
      get: (_, k) => {
        if (k === 'update') return p => { op = 'update'; patch = p; return q; };
        if (k === 'insert') return p => { op = 'insert'; inserted = { id: `n${tables[table].length}`, ...p }; tables[table].push(inserted); return q; };
        if (k === 'eq') return (c, v) => { filters.push(r => r[c] === v); return q; };
        if (k === 'ilike') return (c, v) => { filters.push(r => String(r[c]).toLowerCase() === String(v).toLowerCase()); return q; };
        if (k === 'single' || k === 'maybeSingle') return () => q.then.call(null, x => x, true);
        if (k === 'then') return (ok, one) => {
          if (op === 'update') rows().forEach(r => Object.assign(r, patch));
          const data = op === 'insert' ? (one === true ? inserted : [inserted]) : one === true ? (rows()[0] || null) : rows();
          return ok({ data, error: null });
        };
        if (k === 'catch') return undefined;
        return () => q;
      },
    });
    return q;
  },
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fakeDb };

const { generateToken } = require('../src/utils/token');
const app = express();
app.use(express.json());
app.use('/api/auth', require('../src/routes/auth'));
app.use('/api/students', require('../src/routes/students'));
const tok = {
  admin: generateToken({ id: '00000000-0000-0000-0000-000000000000', username: 'admin', role: 'admin' }),
  teacher: generateToken({ id: 't1', instructor_id: 't1', role: 'instructor' }),
};

let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const call = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('creating a student returns temp_password once, and it logs in with must_change_password', async () => {
  const body = { rfid_uid: 'F3062438', student_id: '123456789012', full_name: 'Dela Cruz, Juan A.', section_id: '22222222-2222-2222-2222-222222222222' };
  const created = await call('POST', '/api/students', tok.admin, body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.temp_password, 'delacruz9012');
  assert.doesNotMatch(tables.audit_log.map(a => a.summary).join('|'), /delacruz9012/);
  const login = await call('POST', '/api/auth/student', null, { student_id: '123456789012', pin: 'delacruz9012' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.json.must_change_password, true);
  assert.equal(require('../src/utils/token').verifyToken(login.json.token).payload.full_name, 'Dela Cruz, Juan A.');
  const bad = await call('POST', '/api/auth/student', null, { student_id: '123456789012', pin: 'wrong-pass' });
  assert.equal(bad.json.error, 'Incorrect password.');
});

test('a student id too short to build a password is 400', async () => {
  const r = await call('POST', '/api/students', tok.admin, { rfid_uid: 'AABBCCDD', student_id: '12', full_name: 'Reyes Maria', section_id: '22222222-2222-2222-2222-222222222222' });
  assert.equal(r.status, 400);
});

test('PUT /:id/password: admin only, min 4, then the student logs in with it', async () => {
  const id = tables.students[0].id;
  assert.equal((await call('PUT', `/api/students/${id}/password`, tok.teacher, { new_password: 'newpass1' })).status, 403);
  assert.equal((await call('PUT', `/api/students/${id}/password`, tok.admin, { new_password: 'abc' })).status, 400);
  const before = tables.audit_log.length;
  assert.equal((await call('PUT', `/api/students/${id}/password`, tok.admin, { new_password: 'newpass1' })).status, 200);
  const audit = tables.audit_log.slice(before);
  assert.deepEqual(audit.map(a => [a.entity, a.action]), [['student', 'reset_password']]);
  assert.doesNotMatch(audit[0].summary, /newpass1/);
  const login = await call('POST', '/api/auth/student', null, { student_id: tables.students[0].student_id, pin: 'newpass1' });
  assert.equal(login.status, 200);
  assert.equal(login.json.must_change_password, true);
});
