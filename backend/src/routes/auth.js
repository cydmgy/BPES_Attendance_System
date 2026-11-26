const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { promisify } = require('util');
const supabase = require('../supabase');
const auth = require('../middleware/auth');
const { generateToken } = require('../utils/token');

const pbkdf2 = promisify(crypto.pbkdf2); // async: a class logging in together must not stall card taps

// ── Timing-Safe String Comparison ────────────────────────────────
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Prevent timing difference based on length by running a dummy compare
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Password & PIN Hashing Helpers ──────────────────────────────
// Stored as "iterations:salt:hash". The older "salt:hash" form (10,000 rounds) still verifies.
// Both are async: always `await` them (a Promise is truthy, so a missing await accepts any password).
const ITERATIONS = 120000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await pbkdf2(password, salt, ITERATIONS, 64, 'sha512')).toString('hex');
  return `${ITERATIONS}:${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  if (!stored.includes(':')) return safeCompare(password, stored); // legacy plain text
  const parts = stored.split(':');
  const [iterations, salt, originalHash] = parts.length === 3 ? [parseInt(parts[0], 10), parts[1], parts[2]] : [10000, parts[0], parts[1]];
  if (!(iterations > 0)) return false;
  const hash = (await pbkdf2(password, salt, iterations, 64, 'sha512')).toString('hex');
  return safeCompare(hash, originalHash);
}

// Unknown accounts verify against this so a miss costs as much as a wrong password (no timing tell).
const DUMMY_HASH = `${ITERATIONS}:${'0'.repeat(32)}:${'0'.repeat(128)}`;

// '*' so a database without must_change_password (migration 011) still logs students in; the response lists its fields one by one.
const STUDENT_COLUMNS = '*, sections(section_name)';

// ── POST /api/auth/student ───────────────────────────────────────
// Authenticate student by LRN (students.student_id, unique) + PIN.
// A student with no PIN cannot log in: an admin sets one (PUT /api/students/:id/password).
router.post('/student', async (req, res) => {
  try {
    const identifier = String(req.body.student_id || req.body.lrn || req.body.username || '').trim();
    const pin = String(req.body.pin || req.body.password || '').trim();

    if (!identifier) {
      return res.status(400).json({ success: false, error: 'LRN is required' });
    }
    if (!pin) {
      return res.status(400).json({ success: false, error: 'PIN / Password is required' });
    }

    const { data: student, error: errId } = await supabase
      .from('students')
      .select(STUDENT_COLUMNS)
      .eq('student_id', identifier)
      .maybeSingle();
    if (errId) throw errId;

    // One answer for an unknown LRN and a wrong PIN, so the form cannot be used to list accounts.
    if (!(await verifyPassword(pin, student?.pin || DUMMY_HASH)) || !student?.pin) {
      return res.status(401).json({
        success: false,
        code: 'INCORRECT_PASSWORD',
        error: 'Incorrect LRN or password.'
      });
    }

    // Upgrade a plain-text PIN to a salted hash
    if (!student.pin.includes(':')) {
      await supabase.from('students').update({ pin: await hashPassword(pin) }).eq('id', student.id);
    }

    // Issue cryptographically secure signed session token
    const token = generateToken({
      id: student.id,
      student_id: student.student_id,
      full_name: student.full_name,
      role: 'student'
    });

    return res.json({
      success: true,
      token,
      must_change_password: !!student.must_change_password,
      user: {
        id: student.id,
        name: student.full_name,
        full_name: student.full_name,
        student_id: student.student_id,
        rfid: student.rfid_uid,
        course: student.course || 'Elementary',
        section: student.sections?.section_name || '—',
        year: student.year_level || 1,
        role: 'student'
      }
    });
  } catch (err) {
    console.error('[POST /api/auth/student]', err);
    return res.status(500).json({ success: false, error: 'Server authentication error' });
  }
});

// ── POST /api/auth/teacher ───────────────────────────────────────
// Authenticate teacher by email + password (emails are unique; names are not)
router.post('/teacher', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '').trim();

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    if (!password) {
      return res.status(400).json({ success: false, error: 'Password is required' });
    }

    const { data: teacher, error } = await supabase
      .from('instructors')
      .select('id, full_name, email, role, password_hash, archived_at')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    if (error) throw error;

    // No stored password = no login; an admin sets one (PUT /api/teachers/:id with a password).
    // An unknown email gets the same 401 as a wrong password, after the same hashing work.
    const isValid = (await verifyPassword(password, teacher?.password_hash || DUMMY_HASH)) && !!teacher?.password_hash && !teacher.archived_at; // archived looks like a wrong password
    // If stored as plain text, upgrade to salted hash on successful login
    if (isValid && !teacher.password_hash.includes(':')) {
      await supabase.from('instructors').update({ password_hash: await hashPassword(password) }).eq('id', teacher.id);
    }

    if (!isValid) {
      return res.status(401).json({
        success: false,
        code: 'INCORRECT_PASSWORD',
        error: 'Incorrect email or password.'
      });
    }

    // Issue cryptographically secure signed session token
    const token = generateToken({
      id: teacher.id,
      instructor_id: teacher.id,
      full_name: teacher.full_name,
      email: teacher.email,
      role: teacher.role || 'instructor'
    });

    return res.json({
      success: true,
      token,
      user: {
        id: teacher.id,
        name: teacher.full_name,
        full_name: teacher.full_name,
        email: teacher.email,
        role: teacher.role || 'instructor'
      }
    });
  } catch (err) {
    console.error('[POST /api/auth/teacher]', err);
    return res.status(500).json({ success: false, error: 'Server authentication error' });
  }
});

// A password saved in admin_settings wins; otherwise ADMIN_PASSWORD (plain text).
// Env fallback only when no hash is stored or the table is missing (migration 011 not applied); any other
// lookup error throws, so a Supabase blip never re-enables the old password.
async function checkAdminPassword(password) {
  const { data, error } = await supabase.from('admin_settings').select('password_hash').maybeSingle();
  if (error && !['42P01', 'PGRST205'].includes(error.code)) throw error;
  if (!error && data?.password_hash) return verifyPassword(password, data.password_hash);
  return safeCompare(password, process.env.ADMIN_PASSWORD);
}

// ── POST /api/auth/admin ─────────────────────────────────────────
router.post('/admin', async (req, res) => {
  try {
    const username = (req.body.username || req.body.full_name || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();

    const expectedUsername = 'admin';
    const configuredPassword = process.env.ADMIN_PASSWORD;
    if (!configuredPassword) {
      return res.status(503).json({ success: false, error: 'Administrator login is not configured (ADMIN_PASSWORD)' });
    }

    // Timing-safe comparison to prevent side-channel timing attacks
    const isUsernameMatch = safeCompare(username, expectedUsername);
    const isPasswordMatch = await checkAdminPassword(password);

    if (!isUsernameMatch || !isPasswordMatch) {
      return res.status(401).json({
        success: false,
        code: 'INCORRECT_PASSWORD',
        error: 'Incorrect username or password.'
      });
    }

    // Issue cryptographically secure signed session token
    const token = generateToken({
      id: '00000000-0000-0000-0000-000000000000',
      username: 'admin',
      role: 'admin'
    });

    return res.json({
      success: true,
      token,
      user: {
        username: 'admin',
        role: 'admin'
      }
    });
  } catch (err) {
    console.error('[POST /api/auth/admin]', err);
    return res.status(500).json({ success: false, error: 'Server authentication error' });
  }
});

// ── POST /api/auth/refresh ───────────────────────────────────────
// Sliding session: a valid token buys a fresh 30 minutes, never past 12 h after the login (auth_time).
// A token from before auth_time existed is capped from its iat (it was issued with up to 12 h left, so this never extends it).
const SESSION_CAP_SECONDS = 12 * 3600;
const BUILT_IN_ADMIN_ID = '00000000-0000-0000-0000-000000000000';
router.post('/refresh', auth, async (req, res) => {
  try {
    const u = req.user;
    const authTime = u.auth_time ?? u.iat;
    const expired = { success: false, code: 'SESSION_EXPIRED', error: 'Session expired, please sign in again.' };
    if (typeof authTime !== 'number' || Math.floor(Date.now() / 1000) - authTime > SESSION_CAP_SECONDS) return res.status(401).json(expired);

    // Cheap account re-check, so a removed or archived account stops at the next refresh instead of lasting its 12 h.
    if (u.id !== BUILT_IN_ADMIN_ID) {
      const isStudent = u.role === 'student';
      const { data: account, error } = await supabase.from(isStudent ? 'students' : 'instructors')
        .select(isStudent ? 'id' : 'id, archived_at').eq('id', u.id).maybeSingle();
      if (error) throw error;
      if (!account || account.archived_at) return res.status(401).json(expired);
    }

    return res.json({ success: true, token: generateToken({ ...u, auth_time: authTime }) });
  } catch (err) {
    console.error('[POST /api/auth/refresh]', err);
    return res.status(500).json({ success: false, error: 'Server authentication error' });
  }
});

module.exports = router;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.safeCompare = safeCompare;
module.exports.checkAdminPassword = checkAdminPassword;
