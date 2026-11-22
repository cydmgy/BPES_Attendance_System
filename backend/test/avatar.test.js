const test = require('node:test');
const assert = require('node:assert/strict');
const { sniffAvatarType, avatarPath, MAX_AVATAR_BYTES } = require('../src/utils/avatar');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);

test('sniffAvatarType accepts JPEG, PNG and WebP', () => {
  assert.equal(sniffAvatarType(JPEG), 'image/jpeg');
  assert.equal(sniffAvatarType(PNG), 'image/png');
  assert.equal(sniffAvatarType(WEBP), 'image/webp');
});

test('sniffAvatarType rejects SVG, GIF, PDF, EXE and empty', () => {
  assert.equal(sniffAvatarType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffAvatarType(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), null);
  assert.equal(sniffAvatarType(Buffer.from('%PDF-1.7')), null);
  assert.equal(sniffAvatarType(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), null);
  assert.equal(sniffAvatarType(Buffer.alloc(0)), null);
});

test('avatarPath: one object per user, admin uses a fixed id', () => {
  assert.equal(avatarPath('student', 'abc', 'image/png'), 'student/abc.png');
  assert.equal(avatarPath('teacher', 'xyz', 'image/jpeg'), 'teacher/xyz.jpg');
  assert.equal(avatarPath('admin', '0000', 'image/webp'), 'admin/admin.webp');
  assert.equal(MAX_AVATAR_BYTES, 1048576);
});
