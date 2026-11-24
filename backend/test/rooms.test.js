// /api/rooms writes: reader (device_id) cleaning, duplicate readers, missing rooms, rooms in use.
// Runs the real router against a table-aware fake database (never touches Supabase).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

// `answer(ops)` returns the { data, error } for the current call; `writes` records insert/update payloads.
let answer, writes;
const fake = {
  from(table) {
    const ops = [];
    const done = () => Promise.resolve(answer(ops));
    const q = new Proxy({}, {
      get: (_, k) => {
        if (k === 'then') return ok => done().then(ok);
        if (k === 'catch') return undefined;
        if (k === 'single' || k === 'maybeSingle') return () => { ops.push({ k }); return done(); };
        return (...args) => { ops.push({ k, args }); if (table === 'rooms' && (k === 'insert' || k === 'update')) writes.push(args[0]); return q; };
      },
    });
    return q;
  },
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake };

const { generateToken } = require('../src/utils/token');
const admin = generateToken({ id: '00000000-0000-0000-0000-000000000000', role: 'admin' });
const ID = '44444444-4444-4444-4444-444444444444';

const app = express();
app.use(express.json());
app.use('/api/rooms', require('../src/routes/rooms'));

let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());
test.beforeEach(() => { writes = []; answer = () => ({ data: null, error: null }); });

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const has = (ops, k) => ops.some(o => o.k === k);
// A write that echoes its payload back as the saved row.
const echo = ops => ({ data: { id: ID, ...writes[writes.length - 1] }, error: null });

test('POST stores a trimmed device_id and null for blank', async () => {
  answer = echo;
  const a = await call('POST', '/api/rooms', { name: ' Room 1 ', device_id: '  ESP32-A  ' });
  assert.equal(a.status, 201);
  assert.equal(writes[0].name, 'Room 1');
  assert.equal(writes[0].device_id, 'ESP32-A');
  assert.equal((await call('POST', '/api/rooms', { name: 'R2', device_id: '   ' })).status, 201);
  assert.equal(writes[1].device_id, null);
  assert.equal((await call('POST', '/api/rooms', { name: 'R3' })).status, 201);
  assert.equal(writes[2].device_id, null);
});

test('POST device_id over 50 chars is 400', async () => {
  const r = await call('POST', '/api/rooms', { name: 'R', device_id: 'x'.repeat(51) });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Reader device ID must be 50 characters or fewer');
  assert.equal((await call('POST', '/api/rooms', { name: 'R', device_id: 5 })).json.error, 'Reader device ID must be text');
  assert.equal(writes.length, 0);
});

test('blank or non-string name is 400', async () => {
  for (const name of ['', '   ', 5, null, {}]) {
    const r = await call('POST', '/api/rooms', { name });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(r.json.error, 'Room name is required');
  }
  assert.equal((await call('PUT', `/api/rooms/${ID}`, { name: '  ' })).status, 400);
  assert.equal((await call('PUT', `/api/rooms/${ID}`, { name: 5 })).status, 400);
  assert.equal((await call('POST', '/api/rooms', { name: 'R', location: 5 })).json.error, 'Location must be text');
  assert.equal(writes.length, 0);
});

test('duplicate device_id on POST is 409 and names the other room', async () => {
  answer = ops => has(ops, 'insert') ? { data: null, error: { code: '23505' } } : { data: { name: 'Room 2' }, error: null };
  const r = await call('POST', '/api/rooms', { name: 'Room 1', device_id: 'ESP32-A' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Reader "ESP32-A" is already assigned to Room 2');
});

test('duplicate device_id with no lookup result says another room', async () => {
  answer = ops => has(ops, 'insert') ? { data: null, error: { code: '23505' } } : { data: null, error: null };
  const r = await call('POST', '/api/rooms', { name: 'Room 1', device_id: 'ESP32-A' });
  assert.equal(r.json.error, 'Reader "ESP32-A" is already assigned to another room');
});

test('PUT can set device_id', async () => {
  answer = echo;
  const r = await call('PUT', `/api/rooms/${ID}`, { device_id: ' ESP32-B ' });
  assert.equal(r.status, 200);
  assert.deepEqual(writes[0], { device_id: 'ESP32-B' });
  assert.equal((await call('PUT', `/api/rooms/${ID}`, { device_id: null })).status, 200);
  assert.deepEqual(writes[1], { device_id: null });
});

test('PUT duplicate device_id is 409', async () => {
  answer = ops => has(ops, 'update') ? { data: null, error: { code: '23505' } } : { data: { name: 'Room 2' }, error: null };
  const r = await call('PUT', `/api/rooms/${ID}`, { device_id: 'ESP32-A' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Reader "ESP32-A" is already assigned to Room 2');
});

test('PUT unknown id is 404', async () => {
  answer = () => ({ data: null, error: { code: 'PGRST116' } });
  const r = await call('PUT', `/api/rooms/${ID}`, { name: 'x' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Room not found');
});

test('DELETE room used by schedules is 409', async () => {
  answer = () => ({ data: null, error: { code: '23503' } });
  const r = await call('DELETE', `/api/rooms/${ID}`);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /used by schedules/);
});

test('DELETE unknown id is 404', async () => {
  answer = () => ({ data: [], error: null });
  assert.equal((await call('DELETE', `/api/rooms/${ID}`)).status, 404);
});

test('DELETE existing room is 200', async () => {
  answer = () => ({ data: [{ name: 'Room 1' }], error: null });
  const r = await call('DELETE', `/api/rooms/${ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
});
