// /api/no-class-days — days with no classes (holidays, suspensions). Cancels that day's open sessions.
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { localDateStr } = require('../utils/time');
const { parseNoClassDay } = require('../utils/noClassDay');

// GET /api/no-class-days -> { days: [{ day, reason }] } from today forward
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('no_class_days')
      .select('day, reason').gte('day', localDateStr()).order('day');
    if (error) throw error;
    return res.json({ days: data || [] });
  } catch (err) {
    console.error('[GET /no-class-days]', err);
    return res.status(500).json({ error: 'Failed to fetch no-class days' });
  }
});

// POST /api/no-class-days { day, reason } — idempotent; cancels every unfinished session on that date
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const parsed = parseNoClassDay(req.body, localDateStr());
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { error } = await supabase.from('no_class_days').upsert(parsed, { onConflict: 'day' });
    if (error) throw error;
    // Sessions may already exist for future days (generated ahead), so cancel for any posted date.
    const { error: cErr } = await supabase.from('class_sessions').update({ status: 'cancelled' })
      .eq('session_date', parsed.day).not('status', 'in', '(closed,cancelled)');
    if (cErr) throw cErr;
    return res.status(201).json({ day: parsed });
  } catch (err) {
    console.error('[POST /no-class-days]', err);
    return res.status(500).json({ error: 'Failed to save no-class day' });
  }
});

// DELETE /api/no-class-days/:day — does not un-cancel sessions
router.delete('/:day', auth, adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('no_class_days').delete().eq('day', req.params.day);
    if (error?.code === '22007' || error?.code === '22008') return res.status(400).json({ error: 'Invalid day' });
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /no-class-days/:day]', err);
    return res.status(500).json({ error: 'Failed to delete no-class day' });
  }
});

module.exports = router;
