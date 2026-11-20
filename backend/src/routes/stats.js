// /api/stats — numbers for the admin Dashboard
// GET /api/stats/overview — row counts (admin only)

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { countBySection } = require('../utils/section');

// Head-only count query: no rows travel, so this stays cheap however many students there are.
const count = (table, filter) => {
  const q = supabase.from(table).select('id', { count: 'exact', head: true });
  return filter ? filter(q) : q;
};

router.get('/overview', auth, adminOnly, async (req, res) => {
  try {
    const results = await Promise.all([
      count('students'),
      count('instructors'),
      count('sections'),
      count('subjects'),
      count('rooms'),
      count('schedules', q => q.eq('status', 'active')),
      count('leave_requests', q => q.eq('status', 'pending')),
      supabase.from('students').select('sections(section_name)'), // rows, for the per-section chart
    ]);
    const failed = results.find(r => r.error);
    if (failed) throw failed.error;

    const [students, teachers, sections, subjects, rooms, active_schedules, pending_leave] = results.slice(0, 7).map(r => r.count ?? 0);
    return res.json({ students, teachers, sections, subjects, rooms, active_schedules, pending_leave, students_per_section: countBySection(results[7].data) });
  } catch (err) {
    console.error('[GET /stats/overview]', err);
    return res.status(500).json({ error: 'Failed to fetch dashboard numbers' });
  }
});

module.exports = router;
