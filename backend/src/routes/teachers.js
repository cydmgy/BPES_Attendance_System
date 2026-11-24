// /api/teachers — Teacher Management
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { hashPassword } = require('./auth');
const { normalizeUid, uidInUse } = require('../utils/uid');
const { logAudit } = require('../utils/audit');

const COLS = 'id, full_name, email, role, rfid_uid, created_at';

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

// A random one-time password, shown to the admin once. Never a shared default.
const newPassword = () => crypto.randomBytes(6).toString('base64url');

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
    const { full_name, email, role = 'instructor', rfid_uid } = req.body;

    if (!full_name || !email) {
      return res.status(400).json({ error: 'Full name and email are required' });
    }

    const rfid = await parseRfid(rfid_uid);
    if (rfid.error) return res.status(rfid.error.status).json({ error: rfid.error.error });

    const password = newPassword();
    const newTeacher = {
      rfid_uid: rfid.value,
      full_name: full_name.trim(),
      email: email.trim().toLowerCase(),
      role: role === 'admin' ? 'admin' : 'instructor',
      password_hash: await hashPassword(password)
    };

    const { data, error } = await supabase
      .from('instructors')
      .insert(newTeacher)
      .select(COLS)
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: error.message.includes('rfid_uid') ? 'This RFID card is already assigned' : 'A teacher with this email already exists' });
      }
      throw error;
    }

    await logAudit(req, { action: 'create', entity: 'teacher', entityId: data.id, summary: `Created teacher "${data.full_name}"` });
    return res.status(201).json({ teacher: data, temp_password: password });
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

    const { full_name, email, role, password, rfid_uid } = req.body;
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name.trim();
    if (email !== undefined)     updates.email = email.trim().toLowerCase();
    if (role !== undefined && req.user?.role === 'admin') updates.role = role;
    if (password !== undefined) {
      // A teacher changes their own password in Settings (it checks the current one); here only an admin resets it.
      if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Change your password in Settings' });
      if (String(password).trim().length >= 6) updates.password_hash = await hashPassword(String(password).trim());
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

// POST /api/teachers/:id/reset-password — admin issues a new one-time password
router.post('/:id/reset-password', auth, adminOnly, async (req, res) => {
  try {
    const password = newPassword();
    const { data, error } = await supabase
      .from('instructors')
      .update({ password_hash: await hashPassword(password) })
      .eq('id', req.params.id)
      .select('id, full_name')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Teacher not found' });
    await logAudit(req, { action: 'reset_password', entity: 'teacher', entityId: data.id, summary: `Reset password for teacher "${data.full_name}"` });
    return res.json({ temp_password: password });
  } catch (err) {
    console.error('[POST /teachers/:id/reset-password]', err);
    return res.status(500).json({ error: 'Failed to reset password' });
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
