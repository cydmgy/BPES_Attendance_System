// /api/teachers — Teacher Management
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { hashPassword } = require('./auth');
const { normalizeUid, uidInUse } = require('../utils/uid');
const { logAudit } = require('../utils/audit');
const { defaultTeacherPassword } = require('../utils/password');
const { BUCKET } = require('../utils/avatar');
const { localDateStr } = require('../utils/time');

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const TOO_LONG = { error: 'A value is too long' }; // Postgres 22001 safety net
const COLS = 'id, employee_id, full_name, email, role, rfid_uid, created_at, archived_at';

const dupMessage = e => e.message.includes('rfid_uid') ? 'This RFID card is already assigned' : e.message.includes('employee_id') ? 'This teacher ID is already in use' : 'A teacher with this email already exists';

// A teacher's card is required (taps on the shared reader identify them): normalised and checked
// against students too. Returns { value } or { error } (error is an HTTP-ready { status, error }).
async function parseRfid(raw, teacherId = null) {
  const value = normalizeUid(raw ?? '').colon;
  if (!value) return { error: { status: 400, error: 'An RFID card is required' } };
  if (await uidInUse(supabase, 'students', value) || await uidInUse(supabase, 'instructors', value, teacherId)) {
    return { error: { status: 409, error: 'This RFID card is already assigned' } };
  }
  return { value };
}

// Default teacher password: surname + last 4 of the employee ID (same rule as students).
// Names are entered "Surname, First M.". Throws when the name has no letters.
const newPassword = (fullName, id) => defaultTeacherPassword(fullName, id);

// GET /api/teachers — List all teachers (admin only: it carries card numbers and emails)
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    let q = supabase.from('instructors').select(COLS).order('full_name', { ascending: true });
    if (req.query.include_archived !== '1') q = q.is('archived_at', null);
    const { data, error } = await q;

    if (error) throw error;
    return res.json({ teachers: data || [] });
  } catch (err) {
    console.error('[GET /teachers]', err);
    return res.status(500).json({ error: 'Failed to fetch teachers' });
  }
});

// POST /api/teachers — Add new teacher
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { full_name, email, rfid_uid } = req.body;
    const employee_id = String(req.body.employee_id ?? '').trim();

    if (typeof full_name !== 'string' || !full_name.trim() || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Full name and email are required' });
    }
    if (full_name.trim().length > 100 || email.trim().length > 100) {
      return res.status(400).json({ error: 'Full name and email must be 100 characters or fewer' });
    }
    if (!EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'Enter a valid email address' });

    const rfid = await parseRfid(rfid_uid);
    if (rfid.error) return res.status(rfid.error.status).json({ error: rfid.error.error });

    let password;
    try { password = newPassword(full_name, employee_id); }
    catch { return res.status(400).json({ error: 'Enter the teacher ID (at least 4 letters or digits) and a name with letters ("Surname, First M.")' }); }
    const newTeacher = {
      employee_id,
      rfid_uid: rfid.value,
      full_name: full_name.trim(),
      email: email.trim().toLowerCase(),
      password_hash: await hashPassword(password)
    };

    const { data, error } = await supabase
      .from('instructors')
      .insert(newTeacher)
      .select(COLS)
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: dupMessage(error) });
      }
      if (error.code === '22001') return res.status(400).json(TOO_LONG);
      throw error;
    }

    await logAudit(req, { action: 'create', entity: 'teacher', entityId: data.id, summary: `Created teacher "${data.full_name}"` });
    return res.status(201).json({ teacher: data });
  } catch (err) {
    console.error('[POST /teachers]', err);
    return res.status(500).json({ error: 'Failed to add teacher' });
  }
});

// PUT /api/teachers/:id — Update teacher
router.put('/:id', auth, async (req, res) => {
  try {
    const targetId = req.params.id;

    // Only admin or the teacher themselves can update their profile
    if (req.user?.role !== 'admin' && req.user?.id !== targetId && req.user?.instructor_id !== targetId) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { full_name, email, password, rfid_uid } = req.body;
    const updates = {};
    // A teacher's own name goes through /api/account/profile and their email (the login) stays with the admin.
    const isAdmin = req.user?.role === 'admin';
    if (full_name !== undefined && isAdmin) {
      updates.full_name = String(full_name).trim();
      if (!updates.full_name || updates.full_name.length > 100) return res.status(400).json({ error: 'Full name is required (max 100 characters)' });
    }
    if (email !== undefined && isAdmin) {
      updates.email = String(email).trim().toLowerCase();
      if (!EMAIL_RE.test(updates.email) || updates.email.length > 100) return res.status(400).json({ error: 'Enter a valid email address (max 100 characters)' });
    }
    if (password !== undefined) {
      // A teacher changes their own password in Settings (it checks the current one); here only an admin resets it.
      if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Change your password in Settings' });
      if (String(password).trim().length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      updates.password_hash = await hashPassword(String(password).trim());
    }

    if (rfid_uid !== undefined && req.user?.role === 'admin') {
      const rfid = await parseRfid(rfid_uid, targetId);
      if (rfid.error) return res.status(rfid.error.status).json({ error: rfid.error.error });
      updates.rfid_uid = rfid.value;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No update fields provided' });
    }

    const { data, error } = await supabase
      .from('instructors')
      .update(updates)
      .eq('id', targetId)
      .select(COLS)
      .maybeSingle();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: dupMessage(error) });
      if (error.code === '22001') return res.status(400).json(TOO_LONG);
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Teacher not found' });

    await logAudit(req, { action: 'update', entity: 'teacher', entityId: data.id, summary: `Updated teacher "${data.full_name}"` });
    return res.json({ message: 'Teacher updated successfully', teacher: data });
  } catch (err) {
    console.error('[PUT /teachers/:id]', err);
    return res.status(500).json({ error: 'Failed to update teacher' });
  }
});

// DELETE /api/teachers/:id — Remove a teacher with no history; archive one who has any (card and email stay reserved)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    // Deleting would null or cascade the teacher on their schedules, sessions, leave reviews, substitutions and co-teaching.
    const id = req.params.id;
    const one = (table, col) => supabase.from(table).select('id').eq(col, id).limit(1);
    const results = await Promise.all([
      supabase.from('schedules').select('status').eq('teacher_id', id), // all rows: any status is history, active blocks archiving
      one('class_sessions', 'actual_teacher_id'), one('leave_requests', 'reviewed_by'),
      one('schedule_overrides', 'sub_teacher_id'), one('schedule_co_teachers', 'teacher_id'),
      one('attendance_overrides', 'changed_by'),
    ]);
    const failed = results.find(r => r.error);
    if (failed) throw failed.error;
    const [schedules, ...others] = results.map(r => r.data || []);
    if (schedules.some(s => s.status === 'active')) {
      return res.status(409).json({ error: 'This teacher owns an active schedule: reassign or archive their schedules first.' });
    }
    if (schedules.length || others.some(r => r.length)) {
      const { data: done, error: archErr } = await supabase.from('instructors')
        .update({ archived_at: new Date().toISOString() }).eq('id', id).select('full_name');
      if (archErr) throw archErr;
      if (!done?.length) return res.status(404).json({ error: 'Teacher not found' });
      // An archived teacher must not stay named as a future substitute; past rows remain as history.
      const { error: subErr } = await supabase.from('schedule_overrides')
        .delete().eq('sub_teacher_id', id).gte('override_date', localDateStr());
      if (subErr) throw subErr;
      await logAudit(req, { action: 'archive', entity: 'teacher', entityId: id, summary: `Archived teacher "${done[0].full_name}"` });
      return res.json({ success: true, archived: true, message: 'Teacher archived (they have class history)' });
    }

    // select('*') so this still works before migration 012 adds avatar_path
    const { data: gone, error } = await supabase
      .from('instructors')
      .delete()
      .eq('id', req.params.id)
      .select('*');

    if (error) throw error;
    if (!gone?.length) return res.status(404).json({ error: 'Teacher not found' });

    if (gone[0].avatar_path) {
      try { await supabase.storage.from(BUCKET).remove([gone[0].avatar_path]); }
      catch (e) { console.error('[DELETE /teachers] avatar cleanup', e); }
    }
    await logAudit(req, { action: 'delete', entity: 'teacher', entityId: req.params.id, summary: `Deleted teacher "${gone[0].full_name}"` });
    return res.json({ success: true, archived: false, message: 'Teacher deleted successfully' });
  } catch (err) {
    console.error('[DELETE /teachers]', err);
    return res.status(500).json({ error: 'Failed to delete teacher' });
  }
});

// POST /api/teachers/:id/restore — Bring an archived teacher back (fine on one who is not archived)
router.post('/:id/restore', auth, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase.from('instructors')
      .update({ archived_at: null }).eq('id', req.params.id).select('full_name');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Teacher not found' });
    await logAudit(req, { action: 'restore', entity: 'teacher', entityId: req.params.id, summary: `Restored teacher "${data[0].full_name}"` });
    return res.json({ success: true });
  } catch (err) {
    console.error('[POST /teachers/:id/restore]', err);
    return res.status(500).json({ error: 'Failed to restore teacher' });
  }
});

module.exports = router;
