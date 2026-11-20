// /api/subjects — Subject management
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { cleanSubjectBody } = require('../utils/subject');

// GET /api/subjects — list all subjects
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subjects')
      .select('*')
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json({ subjects: data || [] });
  } catch (err) {
    console.error('[GET /subjects]', err);
    return res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

// POST /api/subjects — create a subject (admin)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const clean = cleanSubjectBody(req.body, { partial: false });
    if (!clean.ok) return res.status(400).json({ error: clean.error });

    const { data, error } = await supabase.from('subjects').insert(clean.fields).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A subject with that name already exists' });
      throw error;
    }
    return res.status(201).json({ message: 'Subject created', subject: data });
  } catch (err) {
    console.error('[POST /subjects]', err);
    return res.status(500).json({ error: 'Failed to create subject' });
  }
});

// PUT /api/subjects/:id — update a subject (admin)
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const clean = cleanSubjectBody(req.body, { partial: true });
    if (!clean.ok) return res.status(400).json({ error: clean.error });

    const { data, error } = await supabase
      .from('subjects')
      .update(clean.fields)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A subject with that name already exists' });
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Subject not found' });
    return res.json({ message: 'Subject updated', subject: data });
  } catch (err) {
    console.error('[PUT /subjects/:id]', err);
    return res.status(500).json({ error: 'Failed to update subject' });
  }
});

// DELETE /api/subjects/:id — delete a subject (admin). Blocked while schedules or leave requests use it,
// because the foreign keys cascade and would wipe them.
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const count = async (table) => {
      const { count: n, error } = await supabase
        .from(table).select('id', { count: 'exact', head: true }).eq('subject_id', req.params.id);
      if (error) throw error;
      return n || 0;
    };
    const [schedules, leaves] = await Promise.all([count('schedules'), count('leave_requests')]);
    if (schedules || leaves) {
      return res.status(409).json({ error: `Subject is in use by ${schedules} schedule(s) and ${leaves} leave request(s)` });
    }

    const { error } = await supabase.from('subjects').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Subject deleted successfully' });
  } catch (err) {
    console.error('[DELETE /subjects/:id]', err);
    return res.status(500).json({ error: 'Failed to delete subject' });
  }
});

module.exports = router;
