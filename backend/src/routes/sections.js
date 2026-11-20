// /api/sections — homeroom sections (admin-managed). A section's home room is where its schedules are held.
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { isUuid } = require('../utils/schedule');
const { parseGradeLevel } = require('../utils/section');

const SELECT = 'id, section_name, grade_level, home_room_id, created_at, rooms:home_room_id(id, name)';

// GET /api/sections
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('sections').select(SELECT).order('section_name');
    if (error) throw error;
    return res.json({ sections: data || [] });
  } catch (err) {
    console.error('[GET /sections]', err);
    return res.status(500).json({ error: 'Failed to fetch sections' });
  }
});

// POST /api/sections { section_name, home_room_id?, grade_level? (1-6) }
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const name = String(req.body.section_name ?? '').trim();
    const roomId = req.body.home_room_id || null;
    if (!name || name.length > 50) return res.status(400).json({ error: 'Section name is required (max 50 characters)' });
    if (roomId && !isUuid(roomId)) return res.status(400).json({ error: 'Invalid home room' });
    const grade = parseGradeLevel(req.body.grade_level);
    if (grade === undefined) return res.status(400).json({ error: 'Grade level must be a whole number from 1 to 6' });

    const { data, error } = await supabase
      .from('sections').insert({ section_name: name, home_room_id: roomId, grade_level: grade }).select(SELECT).single();
    if (error?.code === '23505') return res.status(409).json({ error: 'A section with this name already exists' });
    if (error?.code === '23503') return res.status(400).json({ error: 'Home room does not exist' });
    if (error) throw error;
    return res.status(201).json({ section: data });
  } catch (err) {
    console.error('[POST /sections]', err);
    return res.status(500).json({ error: 'Failed to create section' });
  }
});

// PUT /api/sections/:id { section_name?, home_room_id?, grade_level? }
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Section not found' });
    const { data: current } = await supabase.from('sections').select('id, home_room_id').eq('id', req.params.id).maybeSingle();
    if (!current) return res.status(404).json({ error: 'Section not found' });

    const updates = {};
    if (req.body.section_name !== undefined) {
      const name = String(req.body.section_name).trim();
      if (!name || name.length > 50) return res.status(400).json({ error: 'Section name is required (max 50 characters)' });
      updates.section_name = name;
    }
    if (req.body.grade_level !== undefined) {
      const grade = parseGradeLevel(req.body.grade_level);
      if (grade === undefined) return res.status(400).json({ error: 'Grade level must be a whole number from 1 to 6' });
      updates.grade_level = grade;
    }
    if (req.body.home_room_id !== undefined) {
      const roomId = req.body.home_room_id || null;
      if (roomId && !isUuid(roomId)) return res.status(400).json({ error: 'Invalid home room' });
      if (roomId !== current.home_room_id) {
        // Schedules copy the home room when created, so moving it under live schedules would orphan them.
        const { count, error: cErr } = await supabase.from('schedules')
          .select('id', { count: 'exact', head: true }).eq('section_id', current.id).eq('status', 'active');
        if (cErr) throw cErr;
        if (count > 0) return res.status(409).json({ error: 'Archive or delete this section\'s schedules before changing its home room' });
        updates.home_room_id = roomId;
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No update fields provided' });

    const { data, error } = await supabase.from('sections').update(updates).eq('id', current.id).select(SELECT).single();
    if (error?.code === '23505') return res.status(409).json({ error: 'A section with this name already exists' });
    if (error?.code === '23503') return res.status(400).json({ error: 'Home room does not exist' });
    if (error) throw error;

    return res.json({ section: data });
  } catch (err) {
    console.error('[PUT /sections/:id]', err);
    return res.status(500).json({ error: 'Failed to update section' });
  }
});

// DELETE /api/sections/:id — cascades to the section's schedules; blocked once any class session exists
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Section not found' });
    const { error } = await supabase.from('sections').delete().eq('id', req.params.id);
    if (error?.code === '23503') return res.status(409).json({ error: 'Section has class session history and cannot be deleted' });
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /sections/:id]', err);
    return res.status(500).json({ error: 'Failed to delete section' });
  }
});

module.exports = router;
