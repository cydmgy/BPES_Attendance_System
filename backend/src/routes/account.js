// Self-service account endpoints for every role (student, teacher, admin).
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { MAX_AVATAR_BYTES, AVATAR_TYPES, BUCKET, sniffAvatarType, avatarPath } = require('../utils/avatar');
const { hashPassword, verifyPassword, checkAdminPassword } = require('./auth');

const ADMIN_ROW = { id: true }; // admin_settings is a single row
// A teacher row can have role 'admin'; only the built-in admin (no instructor_id) uses admin_settings.
const isAdmin = req => req.user.role === 'admin' && !req.user.instructor_id;
const entityOf = req => (req.user.role === 'student' ? 'student' : isAdmin(req) ? 'admin' : 'teacher');

router.use(auth);

// Wrong current passwords only count; keyed by user (this runs after auth) so a stolen token cannot brute-force the password.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: req => req.user?.id ? `user:${req.user.id}` : rateLimit.ipKeyGenerator(req.ip),
  message: { error: 'Too many attempts — try again in a few minutes' },
});

// Signed link to a stored picture. Fails open: a missing picture or a signing error is just "no picture".
const signAvatar = async path => {
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
    return error ? null : data?.signedUrl || null;
  } catch { return null; }
};
// Where this user's picture path lives: their own row, never an id from the request.
const avatarOwner = req => isAdmin(req) ? { table: 'admin_settings', role: 'admin' }
  : { table: req.user.role === 'student' ? 'students' : 'instructors', role: req.user.role === 'student' ? 'student' : 'teacher' };
const readAvatarPath = async (req, o) => {
  const q = supabase.from(o.table).select('*');
  const { data } = await (o.role === 'admin' ? q : q.eq('id', req.user.id)).maybeSingle();
  return data?.avatar_path || null;
};
const saveAvatarPath = (req, o, path) => o.role === 'admin'
  ? supabase.from('admin_settings').upsert({ ...ADMIN_ROW, avatar_path: path, updated_at: new Date().toISOString() })
  : supabase.from(o.table).update({ avatar_path: path }).eq('id', req.user.id).select('id'); // select: a deleted user matches no row

// GET /api/account/me. select('*') on purpose: before migration 012 there is no avatar_path column, and that must not break /me.
router.get('/me', async (req, res) => {
  try {
    const { role, id } = req.user;
    if (isAdmin(req)) {
      const { data } = await supabase.from('admin_settings').select('*').maybeSingle();
      return res.json({ role, full_name: data?.display_name || 'Administrator', email: null, student_id: null, section: null, must_change_password: false, avatar_url: await signAvatar(data?.avatar_path) });
    }
    if (role === 'student') {
      const { data, error } = await supabase.from('students').select('*, sections(section_name)').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Account not found' });
      return res.json({ role, full_name: data.full_name, email: null, student_id: data.student_id, section: data.sections?.section_name || null, must_change_password: !!data.must_change_password, avatar_url: await signAvatar(data.avatar_path) });
    }
    const { data, error } = await supabase.from('instructors').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Account not found' });
    return res.json({ role, full_name: data.full_name, email: data.email, student_id: null, section: null, must_change_password: false, avatar_url: await signAvatar(data.avatar_path) });
  } catch (err) {
    console.error('[GET /api/account/me]', err);
    return res.status(500).json({ error: 'Failed to load account' });
  }
});

// POST /api/account/change-password
router.post('/change-password', passwordLimiter, async (req, res) => {
  try {
    const { role, id } = req.user;
    const body = req.body || {};
    const current = String(body.current_password || '').trim();
    const next = String(body.new_password || '').trim();
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
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' }); // not 401: the portal treats 401 as an expired session

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
    const name = String((req.body || {}).full_name || '').trim();
    if (!name) return res.status(400).json({ error: 'full_name is required' });
    if (name.length > 120) return res.status(400).json({ error: 'Name must be 120 characters or fewer' });

    const { data, error } = isAdmin(req)
      ? await supabase.from('admin_settings').upsert({ ...ADMIN_ROW, display_name: name, updated_at: new Date().toISOString() })
      : await supabase.from('instructors').update({ full_name: name }).eq('id', id).select('id');
    if (error) throw error;
    if (!isAdmin(req) && !data?.length) return res.status(404).json({ error: 'Account not found' });
    await logAudit(req, { action: 'update', entity: entityOf(req), entityId: id, summary: `Updated own profile name to "${name}"` });
    return res.json({ success: true, full_name: name });
  } catch (err) {
    console.error('[PUT /api/account/profile]', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/account/avatar: raw image body, Content-Type is its type. Only ever the caller's own picture.
router.post('/avatar', express.raw({ type: AVATAR_TYPES, limit: MAX_AVATAR_BYTES }), async (req, res) => {
  try {
    const contentType = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!AVATAR_TYPES.includes(contentType)) return res.status(415).json({ error: 'Only JPG, PNG or WebP pictures are allowed.' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return res.status(400).json({ error: 'The picture is empty.' });
    if (sniffAvatarType(body) !== contentType) return res.status(415).json({ error: 'The file content does not match its type.' });

    const o = avatarOwner(req);
    const path = avatarPath(o.role, req.user.id, contentType);
    const old = await readAvatarPath(req, o);
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
    if (upErr) throw upErr;
    const { data: saved, error } = await saveAvatarPath(req, o, path);
    const gone = !error && o.role !== 'admin' && !saved?.length;
    if (error || gone) {
      if (path !== old) await supabase.storage.from(BUCKET).remove([path]); // no orphan; same path was overwritten in place and the row still points at it
      if (error) throw error;
      return res.status(404).json({ error: 'Account not found' });
    }
    if (old && old !== path) await supabase.storage.from(BUCKET).remove([old]).catch(() => {}); // same user, other extension
    await logAudit(req, { action: 'update', entity: o.role, entityId: req.user.id, summary: 'Changed profile picture' });
    return res.json({ avatar_url: await signAvatar(path) });
  } catch (err) {
    console.error('[POST /api/account/avatar]', err);
    return res.status(500).json({ error: 'Failed to save the picture' });
  }
});

// Without this the global handler answers an oversized upload with 500
router.use((err, req, res, next) => err.type === 'entity.too.large'
  ? res.status(413).json({ error: 'The picture is larger than 1 MB.' })
  : next(err));

// DELETE /api/account/avatar
router.delete('/avatar', async (req, res) => {
  try {
    const o = avatarOwner(req);
    const old = await readAvatarPath(req, o);
    const { error } = await saveAvatarPath(req, o, null);
    if (error) throw error;
    if (old) await supabase.storage.from(BUCKET).remove([old]).catch(() => {}); // best effort
    await logAudit(req, { action: 'update', entity: o.role, entityId: req.user.id, summary: 'Removed profile picture' });
    return res.json({ avatar_url: null });
  } catch (err) {
    console.error('[DELETE /api/account/avatar]', err);
    return res.status(500).json({ error: 'Failed to remove the picture' });
  }
});

module.exports = router;
