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

const COLS = 'id, employee_id, full_name, email, role, rfid_uid, created_at';

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
    const { data, error } = await supabase
      .from('instructors')
      .select(COLS)
      .order('full_name', { ascending: true });

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

    if (!full_name || !email) {
      return res.status(400).json({ error: 'Full name and email are required' });
    }

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
        return res.status(409).json({ error: error.message.includes('rfid_uid') ? 'This RFID card is already assigned' : error.message.includes('employee_id') ? 'This teacher ID is already in use' : 'A teacher with this email already exists' });
      }
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
    if (full_name !== undefined) updates.full_name = full_name.trim();
    if (email !== undefined)     updates.email = email.trim().toLowerCase();
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
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Teacher not found' });

    await logAudit(req, { action: 'update', entity: 'teacher', entityId: data.id, summary: `Updated teacher "${data.full_name}"` });
    return res.json({ message: 'Teacher updated successfully', teacher: data });
  } catch (err) {
    console.error('[PUT /teachers/:id]', err);
    return res.status(500).json({ error: 'Failed to update teacher' });
  }
});

// DELETE /api/teachers/:id — Remove teacher
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { data: gone, error } = await supabase
      .from('instructors')
      .delete()
      .eq('id', req.params.id)
      .select('full_name');

    if (error) throw error;
    await logAudit(req, { action: 'delete', entity: 'teacher', entityId: req.params.id, summary: `Deleted teacher "${gone?.[0]?.full_name ?? req.params.id}"` });
    return res.json({ success: true, message: 'Teacher deleted successfully' });
  } catch (err) {
    console.error('[DELETE /teachers]', err);
    return res.status(500).json({ error: 'Failed to delete teacher' });
  }
});

module.exports = router;
