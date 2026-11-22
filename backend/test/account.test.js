// Shared account endpoints, run against a small stateful fake database (never Supabase).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'env-admin-pass';

const tables = { students: [], instructors: [], admin_settings: [], audit_log: [] };
function fakeDb() {
  const from = table => {
    let op = 'select', patch, filters = [];
    const rows = () => tables[table].filter(r => filters.every(f => f(r)));
    const q = new Proxy({}, {
      get: (_, k) => {
        if (k === 'update') return p => { op = 'update'; patch = p; return q; };
        if (k === 'insert') return p => { tables[table].push(p); return q; };
        if (k === 'upsert') return p => {
          const row = tables[table].find(r => r.id === p.id);
          if (row) Object.assign(row, p); else tables[table].push({ ...p });
          return q;
        };
        if (k === 'eq') return (c, v) => { filters.push(r => r[c] === v); return q; };
        if (k === 'ilike') return (c, v) => { filters.push(r => String(r[c]).toLowerCase() === String(v).toLowerCase()); return q; };
        if (k === 'single' || k === 'maybeSingle') return () => q.then.call(null, x => x, true);
        if (k === 'then') return (ok, one) => {
          if (op === 'update') rows().forEach(r => Object.assign(r, patch));
          const data = one === true ? (rows()[0] || null) : rows();
          return ok({ data, error: null });
        };
        if (k === 'catch') return undefined;
        return () => q; // select, order, etc.
      },
    });
    return q;
  };
  return { from };
}
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fakeDb() };

const { generateToken } = require('../src/utils/token');
const { hashPassword } = require('../src/routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../src/routes/auth'));
app.use('/api/account', require('../src/routes/account'));

const SID = '11111111-1111-1111-1111-111111111111';
const TID = '33333333-3333-3333-3333-333333333333';
const tok = {
  student: generateToken({ id: SID, student_id: '123456', role: 'student' }),
  teacher: generateToken({ id: TID, instructor_id: TID, role: 'instructor' }),
  admin: generateToken({ id: '00000000-0000-0000-0000-000000000000', username: 'admin', role: 'admin' }),
};

let server, base;
test.before(async () => {
  tables.students.push({ id: SID, student_id: '123456', full_name: 'Juan Dela Cruz', pin: await hashPassword('1234'), must_change_password: true, sections: { section_name: 'Grade 1-A' } });
  tables.instructors.push({ id: TID, full_name: 'Ana Reyes', email: 'ana@bpes.test', role: 'instructor', password_hash: await hashPassword('teachpass') });
  await new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
test.after(() => server.close());

const call = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('me: student sees section and must_change_password', async () => {
  const { status, json } = await call('GET', '/api/account/me', tok.student);
  assert.equal(status, 200);
  assert.equal(json.role, 'student');
  assert.equal(json.full_name, 'Juan Dela Cruz');
  assert.equal(json.section, 'Grade 1-A');
  assert.equal(json.must_change_password, true);
});

test('change-password: wrong current is 401, short new is 400', async () => {
  assert.equal((await call('POST', '/api/account/change-password', tok.student, { current_password: 'nope', new_password: '5678' })).status, 401);
  assert.equal((await call('POST', '/api/account/change-password', tok.student, { current_password: '1234', new_password: '12' })).status, 400);
  assert.equal((await call('POST', '/api/account/change-password', tok.teacher, { current_password: 'teachpass', new_password: '12345' })).status, 400);
});

test('student changes password, logs in with the new one, flag cleared, audit has no password', async () => {
  const r = await call('POST', '/api/account/change-password', tok.student, { current_password: '1234', new_password: '5678' });
  assert.equal(r.status, 200);
  const login = await call('POST', '/api/auth/student', null, { full_name: 'Juan Dela Cruz', pin: '5678' });
  assert.equal(login.status, 200);
  assert.equal((await call('GET', '/api/account/me', tok.student)).json.must_change_password, false);
  const a = tables.audit_log.find(x => x.action === 'change_password' && x.entity === 'student');
  assert.ok(a);
  assert.ok(!JSON.stringify(a).includes('5678'));
});

test('teacher profile: name changes, email in body is ignored, login by email still works', async () => {
  const r = await call('PUT', '/api/account/profile', tok.teacher, { full_name: 'Ana Q. Reyes', email: 'evil@x.test' });
  assert.equal(r.status, 200);
  const me = (await call('GET', '/api/account/me', tok.teacher)).json;
  assert.equal(me.full_name, 'Ana Q. Reyes');
  assert.equal(me.email, 'ana@bpes.test');
  assert.equal((await call('POST', '/api/auth/teacher', null, { email: 'ana@bpes.test', password: 'teachpass' })).status, 200);
});

test('profile: student is 403, empty name is 400', async () => {
  assert.equal((await call('PUT', '/api/account/profile', tok.student, { full_name: 'X' })).status, 403);
  assert.equal((await call('PUT', '/api/account/profile', tok.teacher, { full_name: '  ' })).status, 400);
});

test('admin: env password works first, then a changed password replaces it', async () => {
  const login = pw => call('POST', '/api/auth/admin', null, { username: 'admin', password: pw });
  assert.equal((await login('env-admin-pass')).status, 200);
  assert.equal((await call('POST', '/api/account/change-password', tok.admin, { current_password: 'wrong', new_password: 'newadmin1' })).status, 401);
  assert.equal((await call('POST', '/api/account/change-password', tok.admin, { current_password: 'env-admin-pass', new_password: 'newadmin1' })).status, 200);
  assert.equal((await login('env-admin-pass')).status, 401);
  assert.equal((await login('newadmin1')).status, 200);
  assert.equal((await call('PUT', '/api/account/profile', tok.admin, { full_name: 'Principal' })).status, 200);
  assert.equal((await call('GET', '/api/account/me', tok.admin)).json.full_name, 'Principal');
});
