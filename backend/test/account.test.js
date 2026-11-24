// Shared account endpoints, run against a small stateful fake database (never Supabase).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'env-admin-pass';

let dbError = null; // set to { code } to make admin_settings lookups fail
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
          if (dbError && table === 'admin_settings' && op === 'select') return ok({ data: null, error: dbError });
          if (op === 'update' && store.failUpdate) return ok({ data: null, error: { message: 'column missing' } });
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
  // Storage fake: records uploads/removals; signError makes signing fail.
  const storage = { from: bucket => ({
    upload: async (path, body, opts) => { store.uploads.push({ bucket, path, size: body.length, opts }); return { error: null }; },
    remove: async paths => { store.removed.push(...paths); return { error: null }; },
    createSignedUrl: async (path, secs) => store.signError ? { data: null, error: { message: 'boom' } } : { data: { signedUrl: `https://signed.test/${bucket}/${path}?t=${secs}` }, error: null },
  }) };
  return { from, storage };
}
const store = { uploads: [], removed: [], signError: false, failUpdate: false };
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
  const login = await call('POST', '/api/auth/student', null, { student_id: '123456', pin: '5678' });
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

test('teacher with role admin uses their own teacher account, not admin_settings', async () => {
  const IID = '44444444-4444-4444-4444-444444444444';
  tables.instructors.push({ id: IID, full_name: 'Head Teacher', email: 'head@bpes.test', role: 'admin', password_hash: await hashPassword('headpass') });
  const t = generateToken({ id: IID, instructor_id: IID, email: 'head@bpes.test', role: 'admin' });
  assert.equal((await call('GET', '/api/account/me', t)).json.full_name, 'Head Teacher');
  assert.equal((await call('POST', '/api/account/change-password', t, { current_password: 'headpass', new_password: 'newhead1' })).status, 200);
  assert.equal((await call('PUT', '/api/account/profile', t, { full_name: 'Head T.' })).status, 200);
  assert.equal(tables.instructors.find(i => i.id === IID).full_name, 'Head T.');
  assert.notEqual(tables.admin_settings[0].display_name, 'Head T.');
  assert.equal((await call('POST', '/api/auth/teacher', null, { email: 'head@bpes.test', password: 'newhead1' })).status, 200);
});

test('admin env fallback: missing table allowed, other lookup errors rejected', async () => {
  tables.admin_settings.length = 0;
  const login = () => call('POST', '/api/auth/admin', null, { username: 'admin', password: 'env-admin-pass' });
  dbError = { code: '42P01' };
  assert.equal((await login()).status, 200);
  dbError = { code: 'PGRST205' };
  assert.equal((await login()).status, 200);
  dbError = { code: '08006' };
  const r = await login();
  dbError = null;
  assert.equal(r.status, 500);
});

// ── profile pictures ──
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const rawCall = async (method, token, body, type = 'image/png') => {
  const res = await fetch(base + '/api/account/avatar', {
    method, body,
    headers: { ...(type ? { 'content-type': type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const IID2 = '55555555-5555-5555-5555-555555555555';

test('avatar: student upload stores the path, signs a link and audits without a file name', async () => {
  const r = await rawCall('POST', tok.student, PNG);
  assert.equal(r.status, 200);
  assert.match(r.json.avatar_url, /^https:\/\/signed\.test\/avatars\/student\//);
  assert.equal(tables.students.find(s => s.id === SID).avatar_path, `student/${SID}.png`);
  const up = store.uploads.at(-1);
  assert.deepEqual([up.bucket, up.path, up.opts.upsert, up.opts.contentType], ['avatars', `student/${SID}.png`, true, 'image/png']);
  const a = tables.audit_log.find(x => x.entity === 'student' && /profile picture/.test(x.summary));
  assert.ok(a);
  assert.ok(!/png|\.jpg|\.webp/i.test(a.summary));
});

test('avatar: teacher goes to instructors, built-in admin upserts admin_settings, instructor-admin uses instructors', async () => {
  assert.equal((await rawCall('POST', tok.teacher, PNG)).status, 200);
  assert.equal(tables.instructors.find(i => i.id === TID).avatar_path, `teacher/${TID}.png`);

  assert.equal((await rawCall('POST', tok.admin, PNG)).status, 200);
  assert.equal(tables.admin_settings.find(r => r.id === true).avatar_path, 'admin/admin.png');

  tables.instructors.push({ id: IID2, full_name: 'Head 2', email: 'h2@bpes.test', role: 'admin' });
  const t = generateToken({ id: IID2, instructor_id: IID2, role: 'admin' });
  assert.equal((await rawCall('POST', t, PNG)).status, 200);
  assert.equal(tables.instructors.find(i => i.id === IID2).avatar_path, `teacher/${IID2}.png`);
  assert.notEqual(tables.admin_settings.find(r => r.id === true).avatar_path, `teacher/${IID2}.png`);
});

test('avatar: wrong header, SVG bytes, empty body, oversize, no token', async () => {
  assert.equal((await rawCall('POST', tok.student, PNG, 'image/jpeg')).status, 415);
  assert.equal((await rawCall('POST', tok.student, PNG, 'text/plain')).status, 415);
  assert.equal((await rawCall('POST', tok.student, Buffer.from('<svg></svg>'), 'image/png')).status, 415);
  assert.equal((await rawCall('POST', tok.student, Buffer.alloc(0), 'image/png')).status, 400);
  const big = Buffer.concat([PNG, Buffer.alloc(1048576)]);
  assert.equal((await rawCall('POST', tok.student, big)).status, 413);
  assert.equal((await rawCall('POST', null, PNG)).status, 401);
  assert.equal((await rawCall('DELETE', null)).status, 401);
});

test('avatar: a failed row update keeps the object when the path is unchanged (overwritten in place)', async () => {
  store.removed.length = 0; store.failUpdate = true;
  const r = await rawCall('POST', tok.student, PNG); // row already points at student/<id>.png
  store.failUpdate = false;
  assert.equal(r.status, 500);
  assert.deepEqual(store.removed, []);
});

test('avatar: a failed row update removes the new object when the extension differs', async () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  store.removed.length = 0; store.failUpdate = true;
  const r = await rawCall('POST', tok.student, JPEG, 'image/jpeg'); // row points at .png
  store.failUpdate = false;
  assert.equal(r.status, 500);
  assert.deepEqual(store.removed, [`student/${SID}.jpg`]);
});

test('me: avatar_url is a string with a picture, null without, and signing errors do not break /me', async () => {
  assert.equal(typeof (await call('GET', '/api/account/me', tok.student)).json.avatar_url, 'string');
  const IID3 = '66666666-6666-6666-6666-666666666666';
  tables.instructors.push({ id: IID3, full_name: 'No Pic', email: 'np@bpes.test', role: 'instructor' });
  const t = generateToken({ id: IID3, instructor_id: IID3, role: 'instructor' });
  assert.equal((await call('GET', '/api/account/me', t)).json.avatar_url, null);
  store.signError = true;
  const r = await call('GET', '/api/account/me', tok.student);
  store.signError = false;
  assert.equal(r.status, 200);
  assert.equal(r.json.avatar_url, null);
});

test('avatar: DELETE clears the column, removes the object and audits', async () => {
  store.removed.length = 0;
  const r = await rawCall('DELETE', tok.student, undefined, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { avatar_url: null });
  assert.equal(tables.students.find(s => s.id === SID).avatar_path, null);
  assert.deepEqual(store.removed, [`student/${SID}.png`]);
  assert.ok(tables.audit_log.find(x => x.summary === 'Removed profile picture' && x.entity === 'student'));
});
