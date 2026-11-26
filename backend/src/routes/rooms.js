// /api/rooms — Room management
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { logAudit } = require('../utils/audit');

// GET /api/rooms — list all rooms
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rooms')
      .select('*')
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json({ rooms: data || [] });
  } catch (err) {
    console.error('[GET /rooms]', err);
    return res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// Validation problems carry a 400 message; the routes' catch blocks turn them into responses.
const bad = msg => Object.assign(new Error(msg), { status: 400 });

// undefined = not provided, null = clear it, else the trimmed text (case kept, matched exactly by the scan route).
function cleanDeviceId(v) {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string') throw bad('Reader device ID must be text');
  const t = v.trim();
  if (t.length > 50) throw bad('Reader device ID must be 50 characters or fewer');
  return t || null;
}

// The provided fields, cleaned. `creating` makes the name mandatory.
function cleanFields({ name, location, device_id } = {}, creating) {
  const f = {};
  if (creating || name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) throw bad('Room name is required');
    if (name.trim().length > 100) throw bad('Room name must be 100 characters or fewer');
    f.name = name.trim();
  }
  if (location !== undefined) {
    if (location !== null && typeof location !== 'string') throw bad('Location must be text');
    f.location = location?.trim() || null;
    if (f.location?.length > 200) throw bad('Location must be 200 characters or fewer');
  }
  const dev = cleanDeviceId(device_id);
  if (dev !== undefined) f.device_id = dev;
  return f;
}

// rooms.name is not unique, so a 23505 here can only be device_id. Look the other room up after the failed write.
async function readerTaken(res, deviceId) {
  const { data } = await supabase.from('rooms').select('name').eq('device_id', deviceId).maybeSingle();
  return res.status(409).json({ error: `Reader "${deviceId}" is already assigned to ${data?.name || 'another room'}` });
}

// POST /api/rooms — create a new room
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const f = cleanFields(req.body, true);
    const { data, error } = await supabase
      .from('rooms')
      .insert({ location: null, device_id: null, ...f })
      .select()
      .single();

    if (error?.code === '23505') return await readerTaken(res, f.device_id);
    if (error?.code === '22001') return res.status(400).json({ error: 'A value is too long' });
    if (error) throw error;
    await logAudit(req, { action: 'create', entity: 'room', entityId: data.id, summary: `Created room "${data.name}"${data.device_id ? ` (reader ${data.device_id})` : ''}` });
    return res.status(201).json({ message: 'Room created', room: data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[POST /rooms]', err);
    return res.status(500).json({ error: 'Failed to create room' });
  }
});

// PUT /api/rooms/:id — update an existing room
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const updates = cleanFields(req.body, false);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No update fields provided' });
    }

    const { data, error } = await supabase
      .from('rooms')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error?.code === '23505') return await readerTaken(res, updates.device_id);
    if (error?.code === 'PGRST116') return res.status(404).json({ error: 'Room not found' });
    if (error?.code === '22001') return res.status(400).json({ error: 'A value is too long' });
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Room not found' });

    await logAudit(req, { action: 'update', entity: 'room', entityId: data.id, summary: `Updated room "${data.name}"${data.device_id ? ` (reader ${data.device_id})` : ''}` });
    return res.json({ message: 'Room updated', room: data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[PUT /rooms/:id]', err);
    return res.status(500).json({ error: 'Failed to update room' });
  }
});

// DELETE /api/rooms/:id — delete a room
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { data: gone, error } = await supabase
      .from('rooms')
      .delete()
      .eq('id', req.params.id)
      .select('name');

    if (error?.code === '23503') return res.status(409).json({ error: 'This room is used by schedules (including archived ones); move them to another room first' });
    if (error) throw error;
    if (!gone?.length) return res.status(404).json({ error: 'Room not found' });
    await logAudit(req, { action: 'delete', entity: 'room', entityId: req.params.id, summary: `Deleted room "${gone[0].name}"` });
    return res.json({ success: true, message: 'Room deleted successfully' });
  } catch (err) {
    console.error('[DELETE /rooms/:id]', err);
    return res.status(500).json({ error: 'Failed to delete room' });
  }
});

module.exports = router;
