// GET /api/audit — admin-only audit log, newest first. Page with next_before (pass it back as ?before=).
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    let q = supabase.from('audit_log').select('*').order('created_at', { ascending: false });
    if (req.query.before) q = q.lt('created_at', String(req.query.before));
    if (req.query.entity) q = q.eq('entity', String(req.query.entity));
    if (req.query.actor_role) q = q.eq('actor_role', String(req.query.actor_role));
    const { data, error } = await q.limit(limit);
    if (error) throw error;
    const rows = data || [];
    return res.json({ rows, next_before: rows.length === limit ? rows[rows.length - 1].created_at : null });
  } catch (err) {
    console.error('[GET /audit]', err);
    return res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

module.exports = router;
