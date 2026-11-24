// Who may call what. Runs the real routers against a fake database, so it never touches Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.SESSION_SECRET = 'test-secret';
process.env.DEV_BYPASS_AUTH = 'true'; // must be ignored
process.env.NODE_ENV = 'test';
delete process.env.ADMIN_PASSWORD;

// A chainable fake query: every method returns itself, and awaiting it yields tables[table].
// Like the real supabase-js builder it has no .catch (calling one throws), so such bugs show up here.
function fakeDb(tables = {}) {
  const query = table => {
    const q = new Proxy({}, { get: (_, k) => (k === 'then' ? ok => ok({ data: tables[table] ?? null, error: null, count: Array.isArray(tables[table]) ? tables[table].length : null }) : k === 'catch' ? undefined : () => q) });
    return q;
  };
  return { from: query, rpc: () => query('rpc') };
}
const stub = fakeDb();
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: stub };

const { generateToken } = require('../src/utils/token');
const { canManageAny, canReviewLeave, canOverrideLog } = require('../src/utils/access');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('../src/routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../src/routes/auth'));
app.use('/api/scan', require('../src/routes/scan'));
app.use('/api/students', require('../src/routes/students'));
app.use('/api/teachers', require('../src/routes/teachers'));
app.use('/api/override', require('../src/routes/override'));
app.use('/api/leave', require('../src/routes/leave'));
app.use('/api/rooms', require('../src/routes/rooms'));
app.use('/api/attendance', require('../src/routes/attendance'));
app.use('/api/stats', require('../src/routes/stats'));
app.use('/api/sections', require('../src/routes/sections'));

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const TEACHER_ID = '33333333-3333-3333-3333-333333333333';
const tokens = {
  admin: generateToken({ id: '00000000-0000-0000-0000-000000000000', role: 'admin' }),
  teacher: generateToken({ id: TEACHER_ID, instructor_id: TEACHER_ID, role: 'instructor' }),
  student: generateToken({ id: STUDENT_ID, student_id: '123456', role: 'student' }),
};

let server, base;
test.before(() => new Promise(r => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const callJson = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const call = async (...args) => (await callJson(...args)).status;

// ── Refused: no login, forged logins, the old shortcuts ────────────────
test('no token, dev tokens and foreign JWTs are all 401, even with DEV_BYPASS_AUTH set', async () => {
  for (const token of [null, 'dev-token', 'test-token', 'eyJhbGciOi.fake.jwt', 'att.bad.sig']) {
    assert.equal(await call('GET', '/api/students', token), 401, String(token));
    assert.equal(await call('GET', '/api/scan/latest-tap', token), 401, String(token));
  }
});

// ── Per role and route group: [method, path, body?, expected status per role] ──
// Allowed calls only need to get past the gate (not 401/403); refused calls must be exactly 403.
const matrix = [
  // students list / write: admin only
  ['GET',    '/api/students',                {}, { student: 403, teacher: 403, admin: 'ok' }],
  ['POST',   '/api/students',                {}, { student: 403, teacher: 403, admin: 400 }],
  ['PUT',    `/api/students/${STUDENT_ID}`,  { full_name: 'x' }, { student: 403, teacher: 403, admin: 'ok' }],
  ['DELETE', `/api/students/${STUDENT_ID}`,  null, { student: 403, teacher: 403, admin: 'ok' }],
  // one student: self or admin
  ['GET',    `/api/students/${STUDENT_ID}`,  null, { student: 'ok', teacher: 403, admin: 'ok' }],
  ['GET',    `/api/students/${OTHER_ID}`,    null, { student: 403, teacher: 403, admin: 'ok' }],
  // teachers: admin only (card numbers, emails)
  ['GET',    '/api/teachers',                null, { student: 403, teacher: 403, admin: 'ok' }],
  ['POST',   '/api/teachers',                {}, { student: 403, teacher: 403, admin: 400 }],
  ['POST',   `/api/teachers/${OTHER_ID}/reset-password`, null, { student: 403, teacher: 403, admin: 'ok' }],
  ['DELETE', `/api/teachers/${OTHER_ID}`,    null, { student: 403, teacher: 403, admin: 'ok' }],
  // tap-to-enroll buffer exposes card numbers: admin only
  ['GET',    '/api/scan/latest-tap',         null, { student: 403, teacher: 403, admin: 200 }],
  ['POST',   '/api/scan/clear-tap',          {}, { student: 403, teacher: 403, admin: 200 }],
  // override and leave review: staff only (the per-class rule is tested below)
  ['PATCH',  `/api/override/${OTHER_ID}`,    { new_status: 'present', reason: 'forgot to tap' }, { student: 403, teacher: 'ok', admin: 'ok' }],
  ['PATCH',  `/api/leave/${OTHER_ID}`,       { action: 'approved' }, { student: 403, teacher: 'ok', admin: 'ok' }],
  // rooms hold the reader mapping: only an admin may change them
  ['POST',   '/api/rooms',                   {}, { student: 403, teacher: 403, admin: 400 }],
  ['PUT',    `/api/rooms/${OTHER_ID}`,       { name: 'x' }, { student: 403, teacher: 403, admin: 'ok' }],
  ['DELETE', `/api/rooms/${OTHER_ID}`,       null, { student: 403, teacher: 403, admin: 'ok' }],
  // dashboard numbers: admin only
  ['GET',    '/api/stats/overview',          null, { student: 403, teacher: 403, admin: 'ok' }],
  // a room's live feed and a log's audit trail name other people: staff only
  ['GET',    `/api/attendance/live?room_id=${OTHER_ID}`, null, { student: 403, teacher: 'ok', admin: 'ok' }],
  ['GET',    `/api/override/${OTHER_ID}`,    null, { student: 403, teacher: 'ok', admin: 'ok' }],
];
for (const [method, path, body, expected] of matrix) {
  for (const role of ['student', 'teacher', 'admin']) {
    test(`${role} ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} -> ${expected[role]}`, async () => {
      const status = await call(method, path, tokens[role], body);
      if (expected[role] === 'ok') assert.ok(![401, 403].includes(status), `got ${status}`);
      else assert.equal(status, expected[role]);
    });
  }
}

test('a teacher may only act on classes they teach: override and leave are 403 for another class', async () => {
  // The fake database has no schedule for this teacher, so the class check must refuse.
  Object.assign(stub, fakeDb({ attendance_logs: { id: 'l', status: 'present', session_id: 's' }, class_sessions: { schedule_id: 'x', session_date: '2026-11-20' },
    leave_requests: { id: 'q', student_id: STUDENT_ID, subject_id: null, leave_date: '2026-11-20', status: 'pending' }, students: { section_id: 'sec' } }));
  assert.equal(await call('PATCH', `/api/override/${OTHER_ID}`, tokens.teacher, { new_status: 'present', reason: 'forgot to tap' }), 403);
  assert.equal(await call('PATCH', `/api/leave/${OTHER_ID}`, tokens.teacher, { action: 'approved' }), 403);
});

// ── Logins ─────────────────────────────────────────────────────────────
test('admin login refuses to work without ADMIN_PASSWORD (no built-in password)', async () => {
  assert.equal(await call('POST', '/api/auth/admin', null, { username: 'admin', password: 'admin123' }), 503);
});

test('a teacher with no stored password cannot log in with teacher123', async () => {
  Object.assign(stub, fakeDb({ instructors: { id: OTHER_ID, full_name: 'T', email: 't@x.y', role: 'instructor', password_hash: null } }));
  assert.equal(await call('POST', '/api/auth/teacher', null, { email: 't@x.y', password: 'teacher123' }), 401);
});

// ── Class check, unit level ────────────────────────────────────────────
const teacher = { role: 'instructor', instructor_id: TEACHER_ID };
const day = '2026-11-20';

test('canManageAny: admin always; student never; teacher only with a matching schedule, co-teaching or substitution', async () => {
  assert.equal(await canManageAny(fakeDb(), { role: 'admin' }, [], day), true);
  assert.equal(await canManageAny(fakeDb({ schedules: [{ id: 's' }] }), { role: 'student' }, ['s'], day), false);
  assert.equal(await canManageAny(fakeDb(), teacher, ['s'], day), false);
  assert.equal(await canManageAny(fakeDb({ schedules: [{ id: 's' }] }), teacher, ['s'], day), true);
  assert.equal(await canManageAny(fakeDb({ schedule_co_teachers: [{ schedule_id: 's' }] }), teacher, ['s'], day), true);
  assert.equal(await canManageAny(fakeDb({ schedule_overrides: [{ schedule_id: 's' }] }), teacher, ['s'], day), true);
  assert.equal(await canManageAny(fakeDb({ schedules: [{ id: 's' }] }), teacher, [], day), false);
});

test('canOverrideLog: a log with no session is admin-only', async () => {
  assert.equal(await canOverrideLog(fakeDb(), teacher, { session_id: null }), false);
  assert.equal(await canOverrideLog(fakeDb(), { role: 'admin' }, { session_id: null }), true);
});

test('canReviewLeave: teacher must teach the student section', async () => {
  const leave = { student_id: STUDENT_ID, subject_id: null, leave_date: day };
  assert.equal(await canReviewLeave(fakeDb({ students: { section_id: 'sec' }, schedules: [{ id: 's' }] }), teacher, leave), true);
  assert.equal(await canReviewLeave(fakeDb({ students: { section_id: 'sec' }, schedules: [] }), teacher, leave), false);
  assert.equal(await canReviewLeave(fakeDb({ students: null }), teacher, leave), false);
});

// ── Hashing ─────────────────────────────────────────────────────────────
test('verifyPassword accepts new and legacy hashes, rejects a wrong password', async () => {
  const fresh = await hashPassword('1234');
  assert.equal(fresh.split(':').length, 3);
  assert.equal(await verifyPassword('1234', fresh), true);
  assert.equal(await verifyPassword('9999', fresh), false);
  const legacy = `abc123:${crypto.pbkdf2Sync('1234', 'abc123', 10000, 64, 'sha512').toString('hex')}`;
  assert.equal(await verifyPassword('1234', legacy), true);
  assert.equal(await verifyPassword('9999', legacy), false);
  assert.equal(await verifyPassword('1234', null), false);
});

// ── Student login: LRN (students.student_id) + PIN ──────────────────────
// The fake database ignores filters, so each test hands it the one row (or none) the lookup would find.
test('student login: the LRN plus the right PIN is 200, a wrong PIN is 401', async () => {
  const a = { id: 'a', full_name: 'Maria Santos', student_id: '111111111111', pin: await hashPassword('1111') };
  Object.assign(stub, fakeDb({ students: a }));
  const ok = await callJson('POST', '/api/auth/student', null, { student_id: '111111111111', pin: '1111' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.id, 'a');
  assert.equal(await call('POST', '/api/auth/student', null, { student_id: '111111111111', pin: '2222' }), 401);
});

test('student login: a full name alone is 400, an LRN that matches nobody is 404', async () => {
  Object.assign(stub, fakeDb({ students: null }));
  assert.equal(await call('POST', '/api/auth/student', null, { full_name: 'Maria Santos', pin: '1111' }), 400);
  assert.equal(await call('POST', '/api/auth/student', null, { student_id: '999999999999', pin: '1111' }), 404);
});

test('student login: no PIN set means no login, even with the last 4 digits of the LRN', async () => {
  Object.assign(stub, fakeDb({ students: { id: 'a', full_name: 'Old Student', student_id: '123456789012', pin: null } }));
  assert.equal(await call('POST', '/api/auth/student', null, { student_id: '123456789012', pin: '9012' }), 401);
});

// ── Teacher login: email + password only ─────────────────────────────────
test('teacher login: right password 200, wrong 401, a name instead of an email 400', async () => {
  Object.assign(stub, fakeDb({ instructors: { id: OTHER_ID, full_name: 'T', email: 't@x.y', role: 'instructor', password_hash: await hashPassword('s3cret-pass') } }));
  assert.equal(await call('POST', '/api/auth/teacher', null, { email: 't@x.y', password: 's3cret-pass' }), 200);
  assert.equal(await call('POST', '/api/auth/teacher', null, { email: 't@x.y', password: 'wrong-pass' }), 401);
  assert.equal(await call('POST', '/api/auth/teacher', null, { full_name: 'T', password: 's3cret-pass' }), 400);
});

// ── Registering a student: the guardian insert must not crash the request ──
test('admin registers a student with a guardian -> 201', async () => {
  Object.assign(stub, fakeDb({ instructors: null, sections: { id: OTHER_ID }, students: { id: 's', full_name: 'New Kid' }, guardians: null }));
  const res = await callJson('POST', '/api/students', tokens.admin, {
    rfid_uid: 'F3062438', student_id: '123456', full_name: 'New Kid', section_id: OTHER_ID,
    guardian: { full_name: 'Parent', phone_number: '0917' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
});

test('a student with attendance history cannot be deleted (409)', async () => {
  Object.assign(stub, fakeDb({ attendance_logs: [{ id: 'l' }] }));
  assert.equal(await call('DELETE', `/api/students/${STUDENT_ID}`, tokens.admin), 409);
});

// ── Leave dates and report ranges ───────────────────────────────────────
test('leave: a missing or unknown leave_type, and an impossible date, are 400 (not 500)', async () => {
  Object.assign(stub, fakeDb({}));
  assert.equal(await call('POST', '/api/leave', tokens.student, { leave_date: '2026-11-20', reason: 'sick' }), 400);
  assert.equal(await call('POST', '/api/leave', tokens.student, { leave_type: 'bogus', leave_date: '2026-11-20', reason: 'sick' }), 400);
  assert.equal(await call('POST', '/api/leave', tokens.student, { leave_type: 'whole_day', leave_date: '2026-02-31', reason: 'sick' }), 400);
});

test('leave: a half day is filed (201); the same date as an existing whole day or the same half is 409', async () => {
  Object.assign(stub, fakeDb({ leave_requests: [] }));
  const body = { leave_type: 'half_day_pm', leave_date: '2026-11-20', reason: 'dentist' };
  assert.equal(await call('POST', '/api/leave', tokens.student, body), 201);

  Object.assign(stub, fakeDb({ leave_requests: [{ id: 'q', leave_type: 'whole_day', status: 'approved' }] }));
  assert.equal(await call('POST', '/api/leave', tokens.student, body), 409);

  Object.assign(stub, fakeDb({ leave_requests: [{ id: 'q', leave_type: 'half_day_pm', status: 'pending' }] }));
  assert.equal(await call('POST', '/api/leave', tokens.student, body), 409);

  Object.assign(stub, fakeDb({ leave_requests: [{ id: 'q', leave_type: 'half_day_am', status: 'pending' }] }));
  assert.equal(await call('POST', '/api/leave', tokens.student, body), 201); // the other half is fine
});

test('weekly report refuses a range longer than about a term', async () => {
  assert.equal(await call('GET', '/api/attendance/weekly?from=2026-01-01&to=2026-12-31', tokens.admin), 400);
});

// ── Admin dashboard numbers ─────────────────────────────────────────────
test('stats overview returns a count per table, 0 for an empty one', async () => {
  Object.assign(stub, fakeDb({ students: [1, 2, 3], instructors: [1], sections: [], subjects: [1, 2], rooms: [1], schedules: [1, 2, 3, 4], leave_requests: [1] }));
  const res = await callJson('GET', '/api/stats/overview', tokens.admin);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { students: 3, teachers: 1, sections: 0, subjects: 2, rooms: 1, active_schedules: 4, pending_leave: 1, students_per_section: [] });
});

// ── Section grade level ─────────────────────────────────────────────────
test('sections: an invalid grade level is 400; a valid or blank one is accepted', async () => {
  Object.assign(stub, fakeDb({ sections: { id: OTHER_ID, section_name: 'Diamond', grade_level: 3 } }));
  assert.equal(await call('POST', '/api/sections', tokens.admin, { section_name: 'Diamond', grade_level: 9 }), 400);
  assert.equal(await call('POST', '/api/sections', tokens.admin, { section_name: 'Diamond', grade_level: '3' }), 201);
  assert.equal(await call('POST', '/api/sections', tokens.admin, { section_name: 'Diamond' }), 201);
  assert.equal(await call('PUT', `/api/sections/${OTHER_ID}`, tokens.admin, { grade_level: 'x' }), 400);
  assert.equal(await call('PUT', `/api/sections/${OTHER_ID}`, tokens.admin, { grade_level: 4 }), 200);
});

// ── Attendance trend (dashboard charts) ──────────────────────────────────
test('attendance trend: every role may ask; an empty term is an empty list; days is capped at the report limit', async () => {
  Object.assign(stub, fakeDb({ attendance_logs: [] }));
  for (const role of ['student', 'teacher', 'admin']) {
    const res = await callJson('GET', '/api/attendance/trend?days=7', tokens[role]);
    assert.equal(res.status, 200, role);
    assert.deepEqual(res.json.days, [], role);
  }
  const { addDays } = require('../src/utils/report');
  const week = (await callJson('GET', '/api/attendance/trend?days=7', tokens.admin)).json;
  assert.equal(week.from, addDays(week.to, -6));
  const capped = (await callJson('GET', '/api/attendance/trend?days=9999', tokens.admin)).json;
  assert.equal(capped.from, addDays(capped.to, -92));
  const dflt = (await callJson('GET', '/api/attendance/trend', tokens.admin)).json;
  assert.equal(dflt.from, addDays(dflt.to, -13));
});

test('attendance trend: no login is 401', async () => {
  assert.equal(await call('GET', '/api/attendance/trend'), 401);
});
