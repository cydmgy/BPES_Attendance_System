// RFID UID normalization. Cards arrive as "F3062438", "f3:06:24:38", "F3 06 24 38", ...
// Stored format is uppercase colon pairs ("F3:06:24:38").
function normalizeUid(raw) {
  const clean = String(raw).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const pairs = clean.match(/.{1,2}/g);
  const colon = pairs ? pairs.join(':') : clean;
  const space = pairs ? pairs.join(' ') : clean;
  // Safe for PostgREST .or(): only alphanumerics, ':' and ' ' can appear.
  const orFilter = [clean, colon, space].map(v => `rfid_uid.eq.${v}`).join(',');
  return { clean, colon, space, orFilter };
}

// True if any row of `table` (students | instructors) already holds this card. Both tables share one reader.
async function uidInUse(client, table, raw, exceptId = null) {
  const { data } = await client.from(table).select('id').or(normalizeUid(raw).orFilter).limit(2);
  return (data || []).some(r => r.id !== exceptId);
}

module.exports = { normalizeUid, uidInUse };
