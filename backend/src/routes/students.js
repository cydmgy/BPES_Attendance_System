// /api/students — CRUD for student management
// GET    /api/students         — list all students (excludes sensitive pin)
// POST   /api/students         — register new student
// GET    /api/students/:id     — get one student + guardians
// PUT    /api/students/:id     — update student info (partial safe update)
// DELETE /api/students/:id     — delete student

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { orSafe } = require('../utils/filter');
const { hashPassword } = require('./auth');
const { normalizeUid, uidInUse } = require('../utils/uid');
const { sectionFields, withSectionName } = require('../utils/section');
const { BUCKET, isTableMissing } = require('../utils/attachment');
const { logAudit } = require('../utils/audit');
const { defaultStudentPassword } = require('../utils/password');

const SAFE_STUDENT_COLUMNS = 'id, rfid_uid, student_id, full_name, course, year_level, section_id, created_at, sections(section_name)';

// GET /api/students — list all students (with optional search). Admin only: it carries card numbers and guardian phones.
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { search, course, year_level, section_id } = req.query;

    let query = supabase
      .from('students')
      .select(`${SAFE_STUDENT_COLUMNS}, guardians(id, full_name, phone_number, relationship)`)
      .order('full_name', { ascending: true });

    if (search) {
      query = query.or(`full_name.ilike.%${orSafe(search)}%,student_id.ilike.%${orSafe(search)}%`);
    }
    if (course)      query = query.eq('course', course);
    if (year_level)  query = query.eq('year_level', parseInt(year_level, 10));
    if (section_id)  query = query.eq('section_id', section_id);

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ students: (data || []).map(withSectionName) });
  } catch (err) {
    console.error('[GET /students]', err);
    return res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// POST /api/students — register a new student (link RFID UID to student profile + optional guardian)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { rfid_uid, student_id, full_name, course, year_level, section, section_id, guardian } = req.body;

    if (!student_id || !full_name) {
      return res.status(400).json({ error: 'student_id and full_name are required' });
    }

    // Accounts only come from card enrollment: no card, no account.
    const formattedRfid = normalizeUid(rfid_uid ?? '').colon;
    if (!formattedRfid) {
      return res.status(400).json({ error: 'An RFID card is required: a student account is created together with its card' });
    }
    if (await uidInUse(supabase, 'instructors', formattedRfid)) {
      return res.status(409).json({ error: 'RFID UID already exists' });
    }
    const sec = await sectionFields(supabase, { section_id, section });
    if (!sec?.section_id) return res.status(400).json({ error: 'A valid section is required' });
    let tempPassword;
    try { tempPassword = defaultStudentPassword(full_name, student_id); }
    catch (e) { return res.status(400).json({ error: 'Student ID (at least 4 characters) and a surname are needed to build the default password' }); }

    const newStudentData = {
      ...sec,
      rfid_uid: formattedRfid,
      student_id: String(student_id).trim(),
      full_name: String(full_name).trim(),
      course: course ? String(course).trim() : 'Elementary',
      year_level: year_level ? parseInt(year_level, 10) : 1,
      pin: await hashPassword(tempPassword),
      must_change_password: true,
    };

    const { data, error } = await supabase
      .from('students')
      .insert(newStudentData)
      .select(SAFE_STUDENT_COLUMNS)
      .single();

    if (error) {
      if (error.code === '23505') {
        const field = error.message.includes('rfid_uid') ? 'RFID UID' : 'Student ID';
        return res.status(409).json({ error: `${field} already exists` });
      }
      throw error;
    }

    // If guardian info was submitted, insert record into guardians table
    if (guardian && (guardian.full_name || guardian.phone_number)) {
      // supabase-js resolves with { error } (a query builder has no .catch), so check it
      const { error: gErr } = await supabase.from('guardians').insert({
        student_id: data.id,
        full_name: String(guardian.full_name || '').trim(),
        phone_number: String(guardian.phone_number || '').trim(),
        relationship: String(guardian.relationship || 'Parent').trim()
      });
      if (gErr) console.warn('[POST /students] Failed to insert guardian record:', gErr.message);
    }

    await logAudit(req, { action: 'create', entity: 'student', entityId: data.id, summary: `Created student "${data.full_name}"` });
    return res.status(201).json({ student: withSectionName(data), temp_password: tempPassword });
  } catch (err) {
    console.error('[POST /students]', err);
    return res.status(500).json({ error: 'Failed to register student' });
  }
});

// GET /api/students/:id — get a single student + their guardians
router.get('/:id', auth, async (req, res) => {
  try {
    // Only an admin or the student themselves
    if (req.user?.role !== 'admin' && req.user?.id !== req.params.id) {
      return res.status(403).json({ error: 'Access denied: can only view your own student profile' });
    }

    const { data: student, error } = await supabase
      .from('students')
      .select(`
        ${SAFE_STUDENT_COLUMNS},
        guardians(id, full_name, phone_number, relationship)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    return res.json({ student: withSectionName(student) });
  } catch (err) {
    console.error('[GET /students/:id]', err);
    return res.status(500).json({ error: 'Failed to fetch student' });
  }
});

// PUT /api/students/:id — update student info (partial safe update)
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { rfid_uid, student_id, full_name, course, year_level, section, section_id } = req.body;

    const updates = {};
    if (rfid_uid !== undefined) {
      updates.rfid_uid = normalizeUid(rfid_uid ?? '').colon;
      if (!updates.rfid_uid) return res.status(400).json({ error: 'A student must keep an RFID card' });
      if (await uidInUse(supabase, 'instructors', updates.rfid_uid)) {
        return res.status(409).json({ error: 'RFID UID already exists' });
      }
    }
    if (student_id !== undefined) updates.student_id = String(student_id).trim();
    if (full_name !== undefined)  updates.full_name = String(full_name).trim();
    if (course !== undefined)     updates.course = String(course).trim();
    if (year_level !== undefined) updates.year_level = parseInt(year_level, 10);
    if (section !== undefined || section_id !== undefined) {
      const sec = await sectionFields(supabase, { section_id, section });
      if (!sec?.section_id) return res.status(400).json({ error: 'A valid section is required' });
      Object.assign(updates, sec);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid update fields provided' });
    }

    const { data, error } = await supabase
      .from('students')
      .update(updates)
      .eq('id', req.params.id)
      .select(SAFE_STUDENT_COLUMNS)
      .single();

    if (error) {
      if (error.code === '23505') {
        const field = error.message.includes('rfid_uid') ? 'RFID UID' : 'Student ID';
        return res.status(409).json({ error: `${field} already exists` });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Student not found' });

    await logAudit(req, { action: 'update', entity: 'student', entityId: data.id, summary: `Updated student "${data.full_name}"` });
    return res.json({ student: withSectionName(data) });
  } catch (err) {
    console.error('[PUT /students/:id]', err);
    return res.status(500).json({ error: 'Failed to update student' });
  }
});

// PUT /api/students/:id/password — admin sets a new password; the student must change it at next login
router.put('/:id/password', auth, adminOnly, async (req, res) => {
  try {
    const pw = String(req.body.new_password ?? '').trim();
    if (pw.length < 4) return res.status(400).json({ error: 'The new password must be at least 4 characters' });

    const { data, error } = await supabase
      .from('students')
      .update({ pin: await hashPassword(pw), must_change_password: true })
      .eq('id', req.params.id)
      .select('id, full_name')
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Student not found' });

    await logAudit(req, { action: 'reset_password', entity: 'student', entityId: data.id, summary: `Reset password of student "${data.full_name}"` });
    return res.json({ success: true });
  } catch (err) {
    console.error('[PUT /students/:id/password]', err);
    return res.status(500).json({ error: 'Failed to set password' });
  }
});

// DELETE /api/students/:id
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    // Deleting would null the student on their logs and erase leave and check-in history
    const { data: history, error: histErr } = await supabase
      .from('attendance_logs').select('id').eq('student_id', req.params.id).limit(1);
    if (histErr) throw histErr;
    if (history?.length) {
      return res.status(409).json({ error: 'This student has attendance history and cannot be deleted. Change their section or card instead.' });
    }

    // Leave requests cascade with the student: remove their medical files from Storage first
    const { data: files, error: fileErr } = await supabase
      .from('leave_attachments').select('storage_path, leave_requests!inner(student_id)').eq('leave_requests.student_id', req.params.id);
    if (fileErr && !isTableMissing(fileErr)) throw fileErr;
    if (files?.length) {
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove(files.map(f => f.storage_path));
      if (rmErr) throw rmErr;
    }

    const { data: gone, error } = await supabase
      .from('students')
      .delete()
      .eq('id', req.params.id)
      .select('full_name');

    if (error) throw error;

    await logAudit(req, { action: 'delete', entity: 'student', entityId: req.params.id, summary: `Deleted student "${gone?.[0]?.full_name ?? req.params.id}"` });
    return res.json({ success: true, message: 'Student deleted' });
  } catch (err) {
    console.error('[DELETE /students/:id]', err);
    return res.status(500).json({ error: 'Failed to delete student' });
  }
});

module.exports = router;
