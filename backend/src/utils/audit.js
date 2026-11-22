// Records who did what. Call after a successful write; it never throws, so an audit failure cannot undo the action.
const supabase = require('../supabase');

async function logAudit(req, { action, entity, entityId, summary }) {
  try {
    const u = req.user || {};
    const { error } = await supabase.from('audit_log').insert({
      actor_id: u.id != null ? String(u.id) : null,
      actor_role: u.role || 'unknown',
      actor_name: u.full_name || u.email || u.username || null,
      action, entity,
      entity_id: entityId != null ? String(entityId) : null,
      summary,
    });
    if (error) throw error;
  } catch (err) {
    console.error('[audit]', err.message || err);
  }
}

module.exports = { logAudit };
