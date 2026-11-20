// Student <-> section helpers. students.section_id -> sections is the only link; the old free-text
// students.section column no longer exists.
const { isUuid } = require('./schedule');

// { section_id } for a section id or an exact section name; {} when neither is given;
// null when the id / name does not match a section (callers answer 400).
async function sectionFields(client, { section_id, section }) {
  let q = client.from('sections').select('id');
  if (section_id) {
    if (!isUuid(section_id)) return null;
    q = q.eq('id', section_id);
  } else {
    const name = section ? String(section).trim() : '';
    if (!name) return {};
    q = q.eq('section_name', name);
  }
  const { data } = await q.maybeSingle();
  return data ? { section_id: data.id } : null;
}

// Responses keep a plain `section` display name (what the portals show): lifts the embedded
// sections(section_name) row of a student onto the student.
function withSectionName(row) {
  if (!row) return row;
  const { sections, ...rest } = row;
  return { ...rest, section: sections?.section_name ?? null };
}

// Grade level of a section: null when blank, 1-6 when valid, undefined when invalid (callers answer 400).
function parseGradeLevel(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : undefined;
}

// Students per section for the dashboard: rows are students with their embedded sections(section_name).
// Natural order ("Grade 2" before "Grade 10"); students without a section are skipped.
function countBySection(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    const name = r?.sections?.section_name;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([section, count]) => ({ section, count }));
}

module.exports = { sectionFields, withSectionName, parseGradeLevel, countBySection };
