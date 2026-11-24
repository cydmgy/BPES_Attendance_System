// POST /api/scan — called by the ESP32 on every card tap (teachers and students share one reader).
//   Teacher card -> opens the class session for this room's current period and rolls the section's
//                   checked-in students into it (SQL open_class_session).
//   Student card -> daily check-in (daily_presence); if the period's session is already open,
//                   also logs this student into it as present/late.
//   Unknown card -> logged as 'unknown' (as before) and offered to Tap-to-Enroll.
// Taps are judged by server time (Asia/Manila).

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const iotAuth = require('../middleware/iotAuth');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { normalizeUid } = require('../utils/uid');
const { localNow, localIso } = require('../utils/time');
const { isUuid } = require('../utils/schedule');
const { noClassBody } = require('../utils/noClassDay');
const { resolveSlot, teacherRole, studentTapStatus } = require('../utils/slot');

// shortcut: both live in this process's memory, so exactly one Render instance may run.
// Upgrade to a table (latest tap) and a unique key (duplicate guard) before scaling out.
// In-memory buffer of the latest card tapped (used by Admin "Tap to Enroll")
let latestScan = null;
// Cards (per room) whose tap is being written right now: closes the check-then-insert race.
const inFlight = new Set();

// GET /api/scan/latest-tap — Polled by admin UI during "Tap to Enroll" (admin only: it exposes card numbers)
router.get('/latest-tap', auth, adminOnly, (req, res) => {
  res.json({ scan: latestScan });
});

// POST /api/scan/clear-tap — Clears the tap buffer
router.post('/clear-tap', auth, adminOnly, (req, res) => {
  latestScan = null;
  res.json({ success: true });
});

// Room from the payload's room_id, else from the reader's device_id (rooms.device_id). No guessing.
async function resolveRoom(roomId, deviceId) {
  if (roomId) {
    if (!isUuid(roomId)) return null;
    const { data } = await supabase.from('rooms').select('id, name').eq('id', roomId).maybeSingle();
    return data;
  }
  if (!deviceId) return null;
  const { data } = await supabase.from('rooms').select('id, name').eq('device_id', deviceId).maybeSingle();
  return data;
}

// The active period this tap belongs to in this room today, or null.
async function findSlot(roomId, now) {
  const { data, error } = await supabase.from('schedules')
    .select('id, section_id, subject_id, teacher_id, start_time, end_time, subjects(name, late_threshold_minutes)')
    .eq('room_id', roomId).eq('day_of_week', now.dayName).eq('status', 'active');
  if (error) throw error;
  return resolveSlot(data, now.minutes);
}

const OPEN_STATUSES = ['ongoing', 'substituted', 'no_teacher'];

// ── Teacher: open the session ───────────────────────────────
async function teacherTap(res, { teacher, room, tapAt, now }) {
  const slot = await findSlot(room.id, now);
  if (!slot) {
    return res.status(404).json({ success: false, role: 'teacher', teacher_name: teacher.full_name, error: `No class in ${room.name} right now` });
  }
  const [{ data: co, error: coErr }, { data: sub, error: subErr }] = await Promise.all([
    supabase.from('schedule_co_teachers').select('teacher_id').eq('schedule_id', slot.id),
    supabase.from('schedule_overrides').select('sub_teacher_id').eq('schedule_id', slot.id).eq('override_date', now.date).maybeSingle(),
  ]);
  if (coErr) throw coErr;
  if (subErr) throw subErr;
  const role = teacherRole(slot, teacher.id, {
    coTeacherIds: (co || []).map(c => c.teacher_id),
    subTeacherId: sub?.sub_teacher_id || null,
  });
  if (!role) {
    return res.status(403).json({ success: false, role: 'teacher', teacher_name: teacher.full_name, error: 'Not assigned to the class in this room now' });
  }

  const { data, error } = await supabase.rpc('open_class_session', {
    p_schedule_id: slot.id,
    p_teacher_id: teacher.id,
    p_tap_time: tapAt.toISOString(),
    p_status: role,
  });
  if (error) throw error;
  const s = data[0];
  // The period was cancelled (no-class day): no session to open or report as "already open".
  if (s.o_status === 'cancelled') return res.status(200).json(noClassBody(null));
  return res.status(200).json({
    success: true,
    role: 'teacher',
    teacher_name: teacher.full_name,
    student_name: null,
    status: s.o_status,
    session_id: s.o_session_id,
    opened: s.o_opened,       // false = this session was already open (repeat tap)
    cloned: s.o_cloned,       // students rolled in as present
    excused: s.o_excused,     // students rolled in as excused (approved leave)
    log_id: null,
  });
}

// ── Unknown card: keep the old behaviour ────────────────────
async function unknownTap(res, { colonUid, room, deviceId, tapAt }) {
  const { data: log, error } = await supabase.from('attendance_logs').insert({
    student_id: null, room_id: room.id, rfid_uid: colonUid, status: 'unknown',
    device_id: deviceId || 'ESP32-NODE-01', timestamp: tapAt.toISOString(),
  }).select('id').single();
  if (error) throw error;
  return res.status(200).json({ success: true, role: 'unknown', student_name: null, status: 'unknown', log_id: log.id });
}

// ── Student: daily check-in (first tap of the day sets morning_time_in) ──
async function studentTap(res, { student, colonUid, room, deviceId, tapAt, now }) {
  const { error: presErr } = await supabase.from('daily_presence').upsert({
    student_id: student.id,
    section_id: student.section_id,
    attendance_date: now.date,
    morning_time_in: tapAt.toISOString(),
    is_present: true,
  }, { onConflict: 'student_id,attendance_date', ignoreDuplicates: true });
  if (presErr) throw presErr;

  const checkedIn = { success: true, role: 'student', student_name: student.full_name, status: 'no_session', log_id: null, session_id: null };

  // Only this student's own section's period counts; any other tap is just the check-in.
  const slot = await findSlot(room.id, now);
  if (!slot || slot.section_id !== student.section_id) return res.status(200).json(checkedIn);

  const { data: session, error: sesErr } = await supabase.from('class_sessions')
    .select('id, status, teacher_time_in').eq('schedule_id', slot.id).eq('session_date', now.date).maybeSingle();
  if (sesErr) throw sesErr;
  // Session not open yet: the teacher's tap will roll this student in.
  if (!session || !OPEN_STATUSES.includes(session.status)) return res.status(200).json(checkedIn);

  const status = studentTapStatus({
    tapAt,
    startAt: new Date(localIso(now.date, slot.start_time)),
    teacherTimeIn: session.teacher_time_in ? new Date(session.teacher_time_in) : null,
    thresholdMinutes: slot.subjects?.late_threshold_minutes,
  });
  const { data: log, error: logErr } = await supabase.from('attendance_logs').insert({
    session_id: session.id, student_id: student.id, room_id: room.id, rfid_uid: colonUid,
    status, device_id: deviceId || 'ESP32-NODE-01', timestamp: tapAt.toISOString(),
  }).select('id, status').single();

  if (logErr?.code === '23505') {
    // First tap wins: already in this session (rolled in by the teacher's tap, or an earlier tap).
    // 409 with the recorded status so the reader can say "already tapped" / "excused".
    const { data: existing } = await supabase.from('attendance_logs')
      .select('id, status').eq('session_id', session.id).eq('student_id', student.id).maybeSingle();
    return res.status(409).json({ ...checkedIn, success: false, status: existing?.status || status, log_id: existing?.id || null, session_id: session.id });
  }
  if (logErr) throw logErr;
  return res.status(200).json({ ...checkedIn, status: log.status, log_id: log.id, session_id: session.id });
}

router.post('/', iotAuth, async (req, res) => {
  const { uid, room_id, device_id } = req.body;

  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid required field: uid' });
  }
  const { clean: cleanHex, colon: colonUid, orFilter } = normalizeUid(uid);
  if (!cleanHex) {
    return res.status(400).json({ error: 'RFID UID contains no valid alphanumeric characters' });
  }

  const tapAt = new Date();
  const now = localNow(tapAt);
  let lockKey = null;

  try {
    // Teachers are looked up first; both tables share the reader (card uniqueness is enforced on write).
    const [{ data: teacher }, { data: student }] = await Promise.all([
      supabase.from('instructors').select('id, full_name').or(orFilter).maybeSingle(),
      supabase.from('students').select('id, full_name, student_id, section_id').or(orFilter).maybeSingle(),
    ]);

    // Tap-to-Enroll buffer is filled before anything can reject the tap.
    latestScan = {
      uid: cleanHex,
      formatted: colonUid,
      raw: uid,
      isRegistered: !!(teacher || student),
      role: teacher ? 'teacher' : student ? 'student' : 'unknown',
      studentName: (teacher || student)?.full_name || null,
      timestamp: tapAt.getTime(),
    };

    const room = await resolveRoom(room_id, device_id);
    if (!room) {
      return res.status(400).json({
        error: room_id
          ? 'Unknown room_id'
          : `Reader "${device_id || '(no device_id)'}" is not assigned to a room; set rooms.device_id`,
      });
    }

    // No-class day: the whole school is closed, so no tap (teacher, student or unknown card) is logged.
    // Fails open: if the lookup errors, taps carry on so a DB hiccup never stops a real school day.
    const { data: closedDay, error: closedErr } = await supabase.from('no_class_days')
      .select('reason').eq('day', now.date).maybeSingle();
    if (closedErr) console.error('[SCAN] no_class_days lookup failed, continuing', closedErr);
    else if (closedDay) return res.status(200).json(noClassBody(closedDay.reason));

    if (teacher) return await teacherTap(res, { teacher, room, tapAt, now });

    // ── Duplicate guard ─────────────────────────────────────
    // Students are covered by the one-row-per-session rule (first tap wins, see studentTap); the time window is for unknown cards.
    // A second tap of the same card arriving while the first is still being written is a duplicate too.
    lockKey = `${cleanHex}|${room.id}`;
    if (inFlight.has(lockKey)) {
      lockKey = null; // not ours to release
      return res.status(409).json({ message: 'Duplicate scan — already logged recently' });
    }
    inFlight.add(lockKey);

    if (!student) {
      const guardMinutes = parseInt(process.env.DUPLICATE_GUARD_MINUTES || '5', 10);
      const guardCutoff = new Date(tapAt.getTime() - guardMinutes * 60 * 1000).toISOString();
      const { data: recentScan } = await supabase.from('attendance_logs')
        .select('id, timestamp').or(orFilter).eq('room_id', room.id).gte('timestamp', guardCutoff)
        .order('timestamp', { ascending: false }).limit(1).maybeSingle();
      if (recentScan) {
        return res.status(409).json({ message: 'Duplicate scan — already logged recently', last_scan: recentScan.timestamp });
      }
    }

    const tap = { colonUid, room, deviceId: device_id, tapAt, now };
    if (!student) return await unknownTap(res, tap);
    return await studentTap(res, { ...tap, student });

  } catch (err) {
    console.error('[SCAN ERROR]', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (lockKey) inFlight.delete(lockKey);
  }
});

module.exports = router;
