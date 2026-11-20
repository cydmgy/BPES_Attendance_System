const test = require('node:test');
const assert = require('node:assert/strict');
const { localNow, localDateStr, localIso, localDayRange } = require('../src/utils/time');
const { normalizeUid } = require('../src/utils/uid');

test('localNow: UTC evening is already the next Manila day', () => {
  // 2026-11-19 17:30 UTC = 2026-11-20 01:30 Manila (Friday)
  const n = localNow(new Date('2026-11-19T17:30:00Z'));
  assert.deepEqual(n, { date: '2026-11-20', dayName: 'Friday', minutes: 90 });
});

test('localNow: midnight is minute 0, not 24:00', () => {
  assert.equal(localNow(new Date('2026-11-19T16:00:00Z')).minutes, 0);
});

test('localDateStr matches localNow().date', () => {
  const d = new Date('2026-11-19T23:59:00Z');
  assert.equal(localDateStr(d), '2026-11-20');
});

test('localIso / localDayRange convert Manila wall time to UTC', () => {
  assert.equal(localIso('2026-11-20', '08:00:00'), '2026-11-20T00:00:00.000Z');
  assert.deepEqual(localDayRange('2026-11-20'), {
    start: '2026-11-19T16:00:00.000Z',
    end: '2026-11-20T15:59:59.000Z',
  });
});

test('normalizeUid: all input shapes give the same stored form', () => {
  for (const raw of ['F3062438', 'f3:06:24:38', 'F3 06 24 38', ' f3-06-24-38 ']) {
    const u = normalizeUid(raw);
    assert.equal(u.clean, 'F3062438');
    assert.equal(u.colon, 'F3:06:24:38');
    assert.equal(u.space, 'F3 06 24 38');
  }
});

test('normalizeUid: orFilter cannot carry PostgREST syntax', () => {
  const u = normalizeUid('AB,rfid_uid.neq.x)');
  assert.equal(u.orFilter, 'rfid_uid.eq.ABRFIDUIDNEQX,rfid_uid.eq.AB:RF:ID:UI:DN:EQ:X,rfid_uid.eq.AB RF ID UI DN EQ X');
});

test('normalizeUid: junk-only input gives empty strings', () => {
  assert.deepEqual(
    { clean: normalizeUid('--').clean, colon: normalizeUid('--').colon },
    { clean: '', colon: '' },
  );
});

// ── schedule helpers ──────────────────────────────────────────
const { isUuid, normTime, dayNameOf, overlaps, scheduleDbError } = require('../src/utils/schedule');

test('normTime accepts HH:MM and HH:MM:SS, rejects junk', () => {
  assert.equal(normTime('8:00'), null);
  assert.equal(normTime('08:00'), '08:00:00');
  assert.equal(normTime('08:05:30'), '08:05:30');
  assert.equal(normTime('24:00'), null);
  assert.equal(normTime('08:60'), null);
  assert.equal(normTime(undefined), null);
});

test('dayNameOf: real dates only', () => {
  assert.equal(dayNameOf('2026-11-20'), 'Friday');
  assert.equal(dayNameOf('2026-11-22'), 'Sunday');
  assert.equal(dayNameOf('2026-02-30'), null);
  assert.equal(dayNameOf('11/20/2026'), null);
});

test('overlaps: back-to-back periods do not collide', () => {
  assert.equal(overlaps('08:00:00', '09:00:00', '09:00:00', '10:00:00'), false);
  assert.equal(overlaps('08:00:00', '09:00:00', '08:59:00', '10:00:00'), true);
  assert.equal(overlaps('08:00:00', '10:00:00', '08:30:00', '09:00:00'), true);
});

test('isUuid', () => {
  assert.equal(isUuid('3f2b8c1e-9d4a-4e0b-8a7c-1b2c3d4e5f60'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(undefined), false);
});

test('scheduleDbError maps each constraint to its conflict type', () => {
  const ex = name => ({ code: '23P01', message: `conflicting key value violates exclusion constraint "${name}"` });
  assert.equal(scheduleDbError(ex('no_room_time_overlap')).body.conflict, 'room');
  assert.equal(scheduleDbError(ex('no_teacher_double_booking')).body.conflict, 'teacher');
  assert.equal(scheduleDbError(ex('no_section_overlap')).body.conflict, 'section');
  assert.equal(scheduleDbError(ex('no_room_time_overlap')).status, 409);
  assert.equal(scheduleDbError(ex('something_else')), null);
  const chk = { code: '23514', message: 'new row violates check constraint "chk_schedules_time_order"' };
  assert.equal(scheduleDbError(chk).status, 400);
  assert.equal(scheduleDbError({ code: '23503', message: 'fk' }).status, 400);
  assert.equal(scheduleDbError({ code: 'XX000', message: 'boom' }), null);
});
