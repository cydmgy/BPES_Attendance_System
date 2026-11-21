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
  name = name.replace(/[\/\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return name || 'attachment';
}

module.exports = { MAX_FILES, MAX_BYTES, ALLOWED_TYPES, BUCKET, attachmentError, nextSlot, extFor, sniffType, cleanFileName };
