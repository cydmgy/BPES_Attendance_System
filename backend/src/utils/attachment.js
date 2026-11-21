// Rules for files attached to a leave request. Pure, so the route and the tests share them.
const MAX_FILES = 3;
const MAX_BYTES = 5242880; // 5 MB, same as the bucket's file_size_limit (migration 010)
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const BUCKET = 'leave-attachments';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const extFor = (contentType) => EXT[contentType];

// The lowest free slot (1..MAX_FILES), or null when all are taken.
function nextSlot(usedSlots) {
  for (let s = 1; s <= MAX_FILES; s++) if (!usedSlots.includes(s)) return s;
  return null;
}

function attachmentError({ contentType, size, usedSlots }) {
  if (!ALLOWED_TYPES.includes(contentType)) return { status: 415, error: 'Only JPG, PNG, WebP or PDF files are allowed.' };
  if (!(size > 0)) return { status: 400, error: 'The file is empty.' };
  if (size > MAX_BYTES) return { status: 413, error: 'The file is larger than 5 MB.' };
  if (nextSlot(usedSlots) === null) return { status: 409, error: `A leave request can have at most ${MAX_FILES} files.` };
  return null;
}

// The header can be spoofed, so the route compares this with the declared type.
function sniffType(buf) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  return null;
}

function cleanFileName(raw) {
  let name = String(raw ?? '');
  try { name = decodeURIComponent(name); } catch { /* keep the raw value */ }
  name = name.replace(/[\/\\\u0000-\u001f\u007f]/g, '').trim();
  name = Array.from(name).slice(0, 120).join('').trim(); // by code point, so the cut never leaves a lone surrogate
  return name || 'attachment';
}

// Migration 010 not applied: the table (Postgres 42P01, PostgREST PGRST205, or PGRST200 for a missing embed) or the bucket is absent.
function isSetupMissing(err) {
  return ['42P01', 'PGRST205', 'PGRST200'].includes(err?.code) || /Bucket not found/i.test(err?.message || '');
}

// Strict form for destructive paths: a stale schema cache (PGRST200) must not look like "no table", or cleanup would be skipped.
function isTableMissing(err) {
  return ['42P01', 'PGRST205'].includes(err?.code);
}

module.exports = { isSetupMissing, isTableMissing, MAX_FILES, MAX_BYTES, ALLOWED_TYPES, BUCKET, attachmentError, nextSlot, extFor, sniffType, cleanFileName };
