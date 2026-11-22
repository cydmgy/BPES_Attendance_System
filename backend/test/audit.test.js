// Audit writer and GET /api/audit, against an in-process fake Supabase client.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';

const inserted = [];
let insertFails = false;
let selectRows = [];
const calls = [];
// Chainable fake: records calls, insert() is recorded/rejects, awaiting a select yields selectRows.
const fake = {
  from: () => {
    const q = new Proxy({}, { get: (_, k) => {
      if (k === 'insert') return row => insertFails ? Promise.reject(new Error('db down')) : (inserted.push(row), Promise.resolve({ error: null }));
      if (k === 'then') return ok => ok({ data: selectRows, error: null });
      return (...a) => (calls.push([k, ...a]), q);
    } });
    return q;
  },
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake };

const { logAudit } = require('../src/utils/audit');
const { generateToken } = require('../src/utils/token');

const ADMIN = { id: '00000000-0000-0000-0000-000000000000', username: 'admin', role: 'admin' };
const entry = { action: 'create', entity: 'student', entityId: 'abc', summary: 'Enrolled student Juan' };

test('logAudit resolves without throwing when the insert rejects', async () => {
  insertFails = true;
  await assert.doesNotReject(logAudit({ user: ADMIN }, entry));
  insertFails = false;
});

test('logAudit stores the admin actor and entry fields', async () => {
  inserted.length = 0;
  await logAudit({ user: ADMIN }, entry);
  assert.deepEqual(inserted[0], {
    actor_id: ADMIN.id, actor_role: 'admin', actor_name: 'admin',
    action: 'create', entity: 'student', entity_id: 'abc', summary: 'Enrolled student Juan',
  });
});

test('actor_name prefers full_name, then email, then username', async () => {
  inserted.length = 0;
  await logAudit({ user: { id: 't1', role: 'instructor', full_name: 'Ana Cruz', email: 'a@x.ph' } }, entry);
  await logAudit({ user: { id: 't2', role: 'instructor', email: 'b@x.ph' } }, entry);
  assert.deepEqual(inserted.map(r => r.actor_name), ['Ana Cruz', 'b@x.ph']);
});

const app = express();
app.use('/api/audit', require('../src/routes/audit'));
let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());
const get = async (path, role) => {
  const token = generateToken(role === 'admin' ? ADMIN : { id: 't1', instructor_id: 't1', role: 'instructor' });
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('GET /api/audit is 403 for a teacher and 200 for admin', async () => {
  assert.equal((await get('/api/audit', 'teacher')).status, 403);
  selectRows = [];
  const r = await get('/api/audit', 'admin');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { rows: [], next_before: null });
});

test('GET /api/audit caps limit at 200, filters, and returns next_before on a full page', async () => {
  selectRows = [{ created_at: '2026-11-22T02:00:00Z' }, { created_at: '2026-11-22T01:00:00Z' }];
  calls.length = 0;
  const r = await get('/api/audit?limit=2&before=2026-11-23T00:00:00Z&entity=student&actor_role=admin', 'admin');
  assert.equal(r.json.next_before, '2026-11-22T01:00:00Z');
  assert.deepEqual(calls.filter(c => ['eq', 'lt', 'limit'].includes(c[0])),
    [['lt', 'created_at', '2026-11-23T00:00:00Z'], ['eq', 'entity', 'student'], ['eq', 'actor_role', 'admin'], ['limit', 2]]);
  calls.length = 0;
  await get('/api/audit?limit=9999', 'admin');
  assert.deepEqual(calls.find(c => c[0] === 'limit'), ['limit', 200]);
});
