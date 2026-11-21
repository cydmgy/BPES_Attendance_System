const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_FILES, MAX_BYTES, ALLOWED_TYPES, BUCKET, attachmentError, nextSlot, extFor, sniffType, cleanFileName } = require('../src/utils/attachment');

test('limits', () => {
  assert.equal(MAX_FILES, 3);
  assert.equal(MAX_BYTES, 5242880);
  assert.deepEqual(ALLOWED_TYPES, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  assert.equal(BUCKET, 'leave-attachments');
});

test('attachmentError', () => {
  assert.equal(attachmentError({ contentType: 'text/html', size: 10, usedSlots: [] }).status, 415);
  assert.equal(attachmentError({ contentType: 'image/png', size: MAX_BYTES + 1, usedSlots: [] }).status, 413);
  assert.equal(attachmentError({ contentType: 'image/png', size: 0, usedSlots: [] }).status, 400);
  assert.equal(attachmentError({ contentType: 'image/png', size: 10, usedSlots: [1, 2, 3] }).status, 409);
  assert.equal(attachmentError({ contentType: 'image/png', size: 1024 * 1024, usedSlots: [1] }), null);
  assert.equal(attachmentError({ contentType: 'application/pdf', size: MAX_BYTES, usedSlots: [] }), null);
});

test('nextSlot gives the lowest free slot', () => {
  assert.equal(nextSlot([]), 1);
  assert.equal(nextSlot([1, 3]), 2);
  assert.equal(nextSlot([1, 2, 3]), null);
});

test('extFor', () => {
  assert.equal(extFor('image/jpeg'), 'jpg');
  assert.equal(extFor('image/png'), 'png');
  assert.equal(extFor('image/webp'), 'webp');
  assert.equal(extFor('application/pdf'), 'pdf');
});

test('sniffType reads magic bytes', () => {
  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp');
  assert.equal(sniffType(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.equal(sniffType(Buffer.from('RIFF\0\0\0\0WAVE')), null);
  assert.equal(sniffType(Buffer.from('<html>')), null); // a spoofed image/png upload
  assert.equal(sniffType(Buffer.alloc(0)), null);
});

test('cleanFileName', () => {
  assert.ok(!cleanFileName('..%2F..%2Fetc%2Fpasswd').includes('/'));
  assert.ok(!cleanFileName('a\b\u0000c.png').match(/[\/\u0000]/));
  assert.doesNotThrow(() => cleanFileName('%E0%A4%A'));
  assert.equal(cleanFileName(''), 'attachment');
  assert.equal(cleanFileName(undefined), 'attachment');
  assert.equal(cleanFileName('Note%20one.pdf'), 'Note one.pdf');
  assert.equal(cleanFileName('a'.repeat(300)).length, 120);
});
