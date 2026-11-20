// User text going into a PostgREST filter.
// likeEscape: for .ilike(col, value) — makes '%', '_' and '\' match themselves.
// orSafe:     for .or('col.ilike.%value%') — also neutralises the characters that split or nest filters.
const likeEscape = s => String(s).replace(/[\\%_]/g, '\\$&');
const orSafe = s => likeEscape(s).replace(/[,()"*]/g, '_').trim();

module.exports = { likeEscape, orSafe };
