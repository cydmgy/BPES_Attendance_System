// /api/stats — numbers for the admin Dashboard
// GET /api/stats/overview — row counts (admin only)

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

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
    ]);
    const failed = results.find(r => r.error);
    if (failed) throw failed.error;

    const [students, teachers, sections, subjects, rooms, active_schedules, pending_leave] = results.map(r => r.count ?? 0);
    return res.json({ students, teachers, sections, subjects, rooms, active_schedules, pending_leave });
  } catch (err) {
    console.error('[GET /stats/overview]', err);
    return res.status(500).json({ error: 'Failed to fetch dashboard numbers' });
  }
});

module.exports = router;
