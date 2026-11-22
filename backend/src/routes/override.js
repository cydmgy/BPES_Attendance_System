// /api/override — Manual attendance corrections (with audit trail)
// PATCH /api/override/:log_id — Change a student's attendance status
// GET   /api/override/:log_id — Retrieve audit trail for a log

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const { canOverrideLog } = require('../utils/access');
const { logAudit } = require('../utils/audit');

// PATCH /api/override/:log_id
// Body: { new_status: "present" | "late" | "absent" | "excused" | "unknown", reason: "..." }
router.patch('/:log_id', auth, async (req, res) => {
  try {
    const { log_id } = req.params;
    const { new_status, reason } = req.body;

    if (req.user?.role !== 'admin' && !req.user?.instructor_id) {
      return res.status(403).json({ error: 'Only registered teachers or administrators can override attendance' });
    }

    // Validate inputs
    const validStatuses = ['present', 'late', 'absent', 'excused', 'unknown'];
    if (!new_status || !validStatuses.includes(new_status)) {
      return res.status(400).json({ error: `new_status must be one of: ${validStatuses.join(', ')}` });
    }
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: 'A reason of at least 5 characters is required' });
    }

    // Fetch the original log to verify existence and get old_status
    const { data: originalLog, error: fetchError } = await supabase
      .from('attendance_logs')
      .select('id, status, student_id, session_id, students(full_name)')
      .eq('id', log_id)
      .single();

    if (fetchError || !originalLog) {
      return res.status(404).json({ error: 'Attendance log not found' });
    }

    const old_status = originalLog.status;

    // Only the class's teacher, a co-teacher, that day's substitute, or an admin
    if (!(await canOverrideLog(supabase, req.user, originalLog))) {
      return res.status(403).json({ error: 'You do not teach this class' });
    }

    // Audit record: the teacher's own row (the built-in admin has none)
    let teacher = null;
    if (req.user.instructor_id) {
      const { data } = await supabase.from('instructors').select('id').eq('id', req.user.instructor_id).maybeSingle();
      teacher = data;
    }

    // Audit record first: if the change below fails there is a stray audit row, never an unaudited change
    const { data: override, error: overrideError } = await supabase
      .from('attendance_overrides')
      .insert({
        attendance_log_id: log_id,
        changed_by: teacher ? teacher.id : null,
        old_status,
        new_status,
        reason: reason.trim(),
      })
      .select()
      .single();

    if (overrideError) throw overrideError;

    // Update the attendance log status
    const { error: updateError } = await supabase
      .from('attendance_logs')
      .update({ status: new_status })
      .eq('id', log_id);

    if (updateError) {
      await supabase.from('attendance_overrides').delete().eq('id', override.id); // best effort
      if (updateError.code === '23514') {
        return res.status(400).json({
          error: "Database constraint error: status must be one of: present, late, absent, excused, unknown"
        });
      }
      throw updateError;
    }

    await logAudit(req, { action: 'override', entity: 'attendance', entityId: log_id, summary: `Changed ${originalLog.students?.full_name || "student"} attendance from ${old_status} to ${new_status}: ${reason.trim()}` });
    return res.json({
      success: true,
      message: `Attendance changed from "${old_status}" to "${new_status}"`,
      student_name: originalLog.students?.full_name,
      override,
    });

  } catch (err) {
    console.error('[PATCH /override/:log_id]', err);
    return res.status(500).json({ error: 'Failed to override attendance' });
  }
});

// GET /api/override/:log_id — get override history for a specific log
router.get('/:log_id', auth, async (req, res) => {
  try {
    // The trail names teachers and their emails: staff only
    if (req.user?.role === 'student') return res.status(403).json({ error: 'Permission denied' });
    const { data, error } = await supabase
      .from('attendance_overrides')
      .select(`
        id, old_status, new_status, reason, created_at,
        changed_by:instructors(full_name, email)
      `)
      .eq('attendance_log_id', req.params.log_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ overrides: data || [] });
  } catch (err) {
    console.error('[GET /override/:log_id]', err);
    return res.status(500).json({ error: 'Failed to fetch override history' });
  }
});

module.exports = router;
