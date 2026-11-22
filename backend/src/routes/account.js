// Self-service account endpoints for every role (student, teacher, admin).
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { hashPassword, verifyPassword, checkAdminPassword } = require('./auth');

const ADMIN_ROW = { id: true }; // admin_settings is a single row
// An instructor row can have role 'admin'; only the built-in admin (no instructor_id) uses admin_settings.
const isAdmin = req => req.user.role === 'admin' && !req.user.instructor_id;
const entityOf = req => (req.user.role === 'student' ? 'student' : isAdmin(req) ? 'admin' : 'teacher');

router.use(auth);

// GET /api/account/me
router.get('/me', async (req, res) => {
  try {
    const { role, id } = req.user;
    if (isAdmin(req)) {
      const { data } = await supabase.from('admin_settings').select('display_name').maybeSingle();
      return res.json({ role, full_name: data?.display_name || 'Administrator', email: null, student_id: null, section: null, must_change_password: false });
    }
    if (role === 'student') {
      const { data, error } = await supabase.from('students').select('full_name, student_id, must_change_password, sections(section_name)').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Account not found' });
      return res.json({ role, full_name: data.full_name, email: null, student_id: data.student_id, section: data.sections?.section_name || null, must_change_password: !!data.must_change_password });
    }
    const { data, error } = await supabase.from('instructors').select('full_name, email').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Account not found' });
    return res.json({ role, full_name: data.full_name, email: data.email, student_id: null, section: null, must_change_password: false });
  } catch (err) {
    console.error('[GET /api/account/me]', err);
    return res.status(500).json({ error: 'Failed to load account' });
  }
});

// POST /api/account/change-password
router.post('/change-password', async (req, res) => {
  try {
    const { role, id } = req.user;
    const current = String(req.body.current_password || '').trim();
    const next = String(req.body.new_password || '').trim();
    const min = role === 'student' ? 4 : 6;
    if (!current || !next) return res.status(400).json({ error: 'current_password and new_password are required' });
    if (next.length < min) return res.status(400).json({ error: `New password must be at least ${min} characters` });

    let ok, write;
    if (isAdmin(req)) {
      ok = await checkAdminPassword(current);
      write = hash => supabase.from('admin_settings').upsert({ ...ADMIN_ROW, password_hash: hash, updated_at: new Date().toISOString() });
    } else {
      const [table, col, extra] = role === 'student' ? ['students', 'pin', { must_change_password: false }] : ['instructors', 'password_hash', {}];
      const { data, error } = await supabase.from(table).select(col).eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Account not found' });
      ok = await verifyPassword(current, data[col]);
      write = hash => supabase.from(table).update({ [col]: hash, ...extra }).eq('id', id);
    }
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const { error: wErr } = await write(await hashPassword(next));
    if (wErr) throw wErr;
    await logAudit(req, { action: 'change_password', entity: entityOf(req), entityId: id, summary: 'Changed own password' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[POST /api/account/change-password]', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

// PUT /api/account/profile: name only; a teacher's email is never changed here
router.put('/profile', async (req, res) => {
  try {
    const { role, id } = req.user;
    if (role === 'student') return res.status(403).json({ error: 'Students cannot edit their profile' });
    const name = String(req.body.full_name || '').trim();
    if (!name) return res.status(400).json({ error: 'full_name is required' });

    const { error } = isAdmin(req)
      ? await supabase.from('admin_settings').upsert({ ...ADMIN_ROW, display_name: name, updated_at: new Date().toISOString() })
      : await supabase.from('instructors').update({ full_name: name }).eq('id', id);
    if (error) throw error;
    await logAudit(req, { action: 'update', entity: entityOf(req), entityId: id, summary: `Updated own profile name to "${name}"` });
    return res.json({ success: true, full_name: name });
  } catch (err) {
    console.error('[PUT /api/account/profile]', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
