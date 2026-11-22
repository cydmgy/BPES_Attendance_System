// Profile picture rules (bucket `avatars`, migration 012). Pure, so the route and the tests share them.
const { sniffType, extFor } = require('./attachment');

const MAX_AVATAR_BYTES = 1048576; // 1 MB, same as the bucket's file_size_limit
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BUCKET = 'avatars';

// Magic bytes only; a PDF (or anything else) that sniffType knows is still not an avatar.
const sniffAvatarType = buf => {
  const t = sniffType(buf);
  return AVATAR_TYPES.includes(t) ? t : null;
};

// One object per user, so a new upload replaces the old one (upsert). role: student | teacher | admin.
const avatarPath = (role, id, type) => `${role}/${role === 'admin' ? 'admin' : id}.${extFor(type)}`;

module.exports = { MAX_AVATAR_BYTES, AVATAR_TYPES, BUCKET, sniffAvatarType, avatarPath };
