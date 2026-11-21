// /api/leave — Leave / Excuse Request management
// POST  /api/leave          — File a new leave request (student or admin)
// GET   /api/leave          — List leave requests (filterable by status)
// PATCH /api/leave/:id      — Approve or reject a request (instructor or admin)
// POST  /api/leave/:id/attachments        — Student attaches a file (raw bytes) to a pending request
// GET   /api/leave/:id/attachments/:attId — Short-lived signed URL to open a file

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const { withSectionName } = require('../utils/section');
const { canReviewLeave } = require('../utils/access');
const { isUuid, dayNameOf } = require('../utils/schedule');
const { LEAVE_TYPES, leaveCoversPeriod, leaveTypesConflict } = require('../utils/leave');
const { MAX_BYTES, ALLOWED_TYPES, BUCKET, attachmentError, nextSlot, extFor, sniffType, cleanFileName, isSetupMissing } = require('../utils/attachment');

const SETUP_ERROR = { error: 'Attachments are not set up yet (migration 010).' };
const ATTACHMENT_COLUMNS = 'leave_attachments(id, slot, file_name, content_type, size_bytes)';

// A student's database id from either their id or their LRN (null when unknown).
async function resolveStudentId(id) {
  if (isUuid(id)) return id;
  const { data } = await supabase.from('students').select('id').eq('student_id', String(id).trim()).maybeSingle();
  return data?.id ?? null;
}

// POST /api/leave — file a leave request
router.post('/', auth, async (req, res) => {
  try {
    let { student_id, leave_type, leave_date, reason } = req.body;

    // If logged in as student, bind student_id to authenticated student
    if (req.user?.role === 'student') {
      student_id = req.user.id || req.user.student_id;
    }

    if (!student_id || !leave_date || !reason || !String(reason).trim()) {
      return res.status(400).json({
        error: 'student_id, leave_date, and reason are required'
      });
    }

    if (!LEAVE_TYPES.includes(leave_type)) {
      return res.status(400).json({ error: `leave_type must be one of: ${LEAVE_TYPES.join(', ')}` });
    }

    // dayNameOf rejects impossible dates such as 2026-02-31
    if (!dayNameOf(leave_date)) {
      return res.status(400).json({ error: 'leave_date must be a real date in YYYY-MM-DD format' });
    }

    // student_id may be an LRN: resolve it to the database id
    student_id = await resolveStudentId(student_id);
    if (!student_id) return res.status(404).json({ error: 'Student record not found' });

    // One request per day and part of the day: a whole day clashes with everything, a half day with the same half
    const { data: sameDay } = await supabase
      .from('leave_requests')
      .select('id, status, leave_type')
      .eq('student_id', student_id)
      .eq('leave_date', leave_date)
      .neq('status', 'rejected');
    const clash = (Array.isArray(sameDay) ? sameDay : []).find(r => leaveTypesConflict(r.leave_type, leave_type));
    if (clash) {
      return res.status(409).json({
        error: `A leave request already exists for this date (status: ${clash.status})`,
        existing_id: clash.id
      });
    }

    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        student_id,
        leave_type,
        leave_date,
        reason: reason.trim(),
        status: 'pending'
      })
      .select(`
        id, leave_date, leave_type, reason, status, created_at,
        students(full_name, student_id)
      `)
      .single();

    if (error) throw error;

    return res.status(201).json({ leave_request: data });
  } catch (err) {
    console.error('[POST /leave]', err);
    return res.status(500).json({ error: 'Failed to file leave request' });
  }
});

// GET /api/leave?status=pending&subject_id=xxx — list leave requests
router.get('/', auth, async (req, res) => {
  try {
    const { status, subject_id, student_id } = req.query;

    // Students only ever see their own requests
    const isStudent = req.user?.role === 'student';
    const onlyStudent = isStudent
      ? await resolveStudentId(req.user.id || req.user.student_id)
      : student_id ? await resolveStudentId(student_id) : undefined;

    const run = (withAttachments) => {
      let query = supabase
        .from('leave_requests')
        .select(`
          id, student_id, subject_id, leave_date, leave_type, reason, status, created_at, reviewed_at,
          students(id, full_name, student_id, sections(section_name)),
          subjects(id, name, code),
          reviewed_by:instructors(id, full_name, email)${withAttachments ? ', ' + ATTACHMENT_COLUMNS : ''}
        `)
        .order('created_at', { ascending: false });
      if (onlyStudent !== undefined) query = query.eq('student_id', onlyStudent);
      if (status)     query = query.eq('status', status);
      if (subject_id) query = query.eq('subject_id', subject_id);
      return query;
    };

    let { data, error } = await run(true);
    // Migration 010 not applied yet: keep the leave list working without attachments
    if (error && isSetupMissing(error)) ({ data, error } = await run(false));
    if (error) throw error;

    // File names can reveal health details: a teacher sees them only for students they may review
    const canOpen = new Map();
    const mayOpen = async (r) => {
      if (isStudent) return true;
      const key = `${r.student_id}|${r.subject_id ?? ''}|${r.leave_date}`;
      if (!canOpen.has(key)) canOpen.set(key, await canReviewLeave(supabase, req.user, r));
      return canOpen.get(key);
    };
    const leave_requests = [];
    for (const r of data || []) {
      leave_requests.push({
        ...r,
        students: r.students && withSectionName(r.students),
        leave_attachments: (await mayOpen(r)) ? (r.leave_attachments || []).sort((a, b) => a.slot - b.slot) : [],
      });
    }
    return res.json({ leave_requests, count: leave_requests.length });
  } catch (err) {
    console.error('[GET /leave]', err);
    return res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

// POST /api/leave/:id/attachments — body is the raw file; Content-Type is its type, x-file-name its URL-encoded name.
// auth runs before the parser so unauthenticated requests are never buffered.
router.post('/:id/attachments', auth, express.raw({ type: ALLOWED_TYPES, limit: MAX_BYTES }), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Leave request not found' });
    const { data: leave, error: lErr } = await supabase
      .from('leave_requests').select('id, student_id, status').eq('id', req.params.id).maybeSingle();
    if (lErr) throw lErr;
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });

    const owner = req.user?.role === 'student'
      && leave.student_id === await resolveStudentId(req.user.id || req.user.student_id);
    if (!owner) return res.status(403).json({ error: 'Only the student who filed this request can attach files' });
    if (leave.status !== 'pending') return res.status(403).json({ error: 'Files can only be added while the request is pending' });

    const { data: rows, error: sErr } = await supabase
      .from('leave_attachments').select('slot').eq('leave_request_id', leave.id);
    if (sErr) throw sErr;
    const usedSlots = (rows || []).map(r => r.slot);

    const contentType = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); // a type the parser skipped leaves no Buffer
    const bad = attachmentError({ contentType, size: body.length, usedSlots });
    if (bad) return res.status(bad.status).json({ error: bad.error });
    if (sniffType(body) !== contentType) return res.status(415).json({ error: 'The file content does not match its type.' });

    const slot = nextSlot(usedSlots);
    const path = `${leave.id}/${slot}-${crypto.randomUUID()}.${extFor(contentType)}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, body, { contentType });
    if (upErr) throw upErr;

    const { data: att, error: insErr } = await supabase.from('leave_attachments')
      .insert({
        leave_request_id: leave.id, slot, storage_path: path,
        file_name: cleanFileName(req.get('x-file-name')), content_type: contentType, size_bytes: body.length,
      })
      .select('id, slot, file_name, content_type, size_bytes')
      .single();
    if (insErr) {
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove([path]); // no orphan file
      if (rmErr) console.error('[attachments] orphan', path, rmErr);
      if (insErr.code === '23505') return res.status(409).json({ error: 'That slot was just taken. Try again.' });
      throw insErr;
    }
    return res.status(201).json({ attachment: att });
  } catch (err) {
    if (isSetupMissing(err)) return res.status(500).json(SETUP_ERROR);
    console.error('[POST /leave/:id/attachments]', err);
    return res.status(500).json({ error: 'Failed to upload the file' });
  }
});

// Without this the global handler answers an oversized upload with 500
router.use((err, req, res, next) => err.type === 'entity.too.large'
  ? res.status(413).json({ error: 'File is larger than 5 MB.' })
  : next(err));

// GET /api/leave/:id/attachments/:attId — { url }, a signed link valid for 5 minutes
router.get('/:id/attachments/:attId', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.attId)) return res.status(404).json({ error: 'Attachment not found' });
    const { data: leave, error: lErr } = await supabase
      .from('leave_requests').select('id, student_id, subject_id, leave_date').eq('id', req.params.id).maybeSingle();
    if (lErr) throw lErr;
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });

    const owner = req.user?.role === 'student'
      && leave.student_id === await resolveStudentId(req.user.id || req.user.student_id);
    if (!owner && !(await canReviewLeave(supabase, req.user, leave))) {
      return res.status(403).json({ error: 'You may not open this file' });
    }

    // Both ids must match, so another request's attachment id cannot be opened through this one
    const { data: att, error: aErr } = await supabase
      .from('leave_attachments').select('storage_path').eq('id', req.params.attId).eq('leave_request_id', leave.id).maybeSingle();
    if (aErr) throw aErr;
    if (!att) return res.status(404).json({ error: 'Attachment not found' });

    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(att.storage_path, 300);
    if (error) throw error;
    return res.json({ url: data.signedUrl });
  } catch (err) {
    if (isSetupMissing(err)) return res.status(500).json(SETUP_ERROR);
    console.error('[GET /leave/:id/attachments/:attId]', err);
    return res.status(500).json({ error: 'Failed to open the file' });
  }
});

// PATCH /api/leave/:id — approve or reject a leave request
// Body: { action: "approved" | "rejected" }
router.patch('/:id', auth, async (req, res) => {
  try {
    const action = req.body.action || req.body.status;

    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approved" or "rejected"' });
    }

    // Only teachers and admins review leave
    if (req.user?.role !== 'admin' && !req.user?.instructor_id) {
      return res.status(403).json({ error: 'Only instructors or administrators can review leave requests' });
    }
    // Reviewer record (the built-in admin has none)
    let instructor = null;
    if (req.user.instructor_id) {
      const { data } = await supabase.from('instructors').select('id').eq('id', req.user.instructor_id).maybeSingle();
      instructor = data;
    }

    // Fetch the leave request
    const { data: leave, error: fetchError } = await supabase
      .from('leave_requests')
      .select('id, student_id, subject_id, leave_type, leave_date, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !leave) {
      return res.status(404).json({ error: 'Leave request not found' });
    }

    // A teacher may only review leave for students of a class they teach that day
    if (!(await canReviewLeave(supabase, req.user, leave))) {
      return res.status(403).json({ error: 'You do not teach this student' });
    }

    if (leave.status !== 'pending') {
      return res.status(409).json({ error: `Request is already ${leave.status}` });
    }

    const reviewerId = instructor ? instructor.id : null;

    // Approved: first excuse the student in that date's sessions that already exist (open, no_teacher or closed),
    // only the leave's subject when it names one. Sessions not opened yet pick the leave up themselves
    // when they roll students in (roll_in_students), so nothing is invented for them here.
    let excusedSessions = 0;
    if (action === 'approved') {
      const { data: student } = await supabase
        .from('students').select('section_id, rfid_uid').eq('id', leave.student_id).maybeSingle();

      if (student?.section_id) {
        let sq = supabase.from('class_sessions')
          .select('id, schedules!inner(section_id, subject_id, room_id, start_time)')
          .eq('session_date', leave.leave_date)
          .not('status', 'in', '(pending,cancelled)')
          .eq('schedules.section_id', student.section_id);
        const { data: sessions, error: sErr } = await sq;
        if (sErr) throw sErr;

        for (const s of sessions || []) {
          if (!leaveCoversPeriod(leave, s.schedules)) continue; // the other half of the day, or another subject
          const { data: log, error: lErr } = await supabase.from('attendance_logs')
            .select('id, status').eq('session_id', s.id).eq('student_id', leave.student_id).maybeSingle();
          if (lErr) throw lErr;
          if (log?.status === 'excused') continue;

          if (log) {
            // audit row first, so a change is never unaudited
            const { error: aErr } = await supabase.from('attendance_overrides').insert({
              attendance_log_id: log.id,
              changed_by: reviewerId,
              old_status: log.status,
              new_status: 'excused',
              reason: 'Leave request approved',
            });
            if (aErr) throw aErr;
            const { error: uErr } = await supabase.from('attendance_logs').update({ status: 'excused' }).eq('id', log.id);
            if (uErr) throw uErr;
          } else {
            const { error: iErr } = await supabase.from('attendance_logs').insert({
              session_id: s.id,
              student_id: leave.student_id,
              room_id: s.schedules.room_id,
              rfid_uid: student.rfid_uid,
              status: 'excused',
              device_id: 'SYSTEM',
              timestamp: new Date().toISOString(),
            });
            if (iErr && iErr.code !== '23505') throw iErr; // 23505: a tap/cron wrote it meanwhile
          }
          excusedSessions++;
        }
      }
    }

    // Status last, and only while still pending: a failed excuse above leaves the request pending to retry,
    // and two reviewers cannot both approve it.
    const { data: updated, error: updateError } = await supabase
      .from('leave_requests')
      .update({
        status: action,
        reviewed_by: reviewerId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('status', 'pending')
      .select('id');

    if (updateError) throw updateError;
    if (!updated?.length) return res.status(409).json({ error: 'Request was already reviewed' });

    return res.json({
      success: true,
      message: `Leave request ${action}`,
      action,
      excused_sessions: excusedSessions,
    });

  } catch (err) {
    console.error('[PATCH /leave/:id]', err);
    return res.status(500).json({ error: 'Failed to process leave request' });
  }
});

module.exports = router;
