const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { promisify } = require('util');
const supabase = require('../supabase');
const { generateToken } = require('../utils/token');
const { likeEscape } = require('../utils/filter');

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

// '*' so a database without must_change_password (migration 011) still logs students in; the response lists its fields one by one.
const STUDENT_COLUMNS = '*, sections(section_name)';

// ── POST /api/auth/student ───────────────────────────────────────
// Authenticate student by Full Name (LRN / student_id as a fallback) + PIN.
// A student with no PIN cannot log in: an admin sets one (PUT /api/students/:id/password).
router.post('/student', async (req, res) => {
  try {
    const identifier = String(req.body.full_name || req.body.name || req.body.student_id || req.body.lrn || req.body.username || '').trim();
    const pin = String(req.body.pin || req.body.password || '').trim();

    if (!identifier) {
      return res.status(400).json({ success: false, error: 'Full name or Student ID / LRN is required' });
    }
    if (!pin) {
      return res.status(400).json({ success: false, error: 'PIN / Password is required' });
    }

    // Full names are not unique: take every match, and let the PIN pick the student.
    let { data: candidates, error: errName } = await supabase
      .from('students')
      .select(STUDENT_COLUMNS)
      .ilike('full_name', likeEscape(identifier));
    if (errName) throw errName;

    if (!candidates?.length) {
      const { data: byId, error: errId } = await supabase
        .from('students')
        .select(STUDENT_COLUMNS)
        .eq('student_id', identifier);
      if (errId) throw errId;
      candidates = byId;
    }

    if (!candidates?.length) {
      return res.status(404).json({
        success: false,
        code: 'ACCOUNT_NOT_FOUND',
        error: `Account does not exist. No student record found for "${identifier}".`
      });
    }

    const matches = [];
    for (const s of candidates) {
      if (s.pin && await verifyPassword(pin, s.pin)) matches.push(s);
    }

    if (matches.length === 0) {
      return res.status(401).json({
        success: false,
        code: 'INCORRECT_PASSWORD',
        error: 'Incorrect password.'
      });
    }
    if (matches.length > 1) {
      return res.status(409).json({
        success: false,
        code: 'AMBIGUOUS_ACCOUNT',
        error: 'Two students have this name and PIN. Ask the school administrator to change one PIN.'
      });
    }
    const student = matches[0];

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
      .select('id, full_name, email, role, password_hash')
      .ilike('email', likeEscape(email))
      .maybeSingle();
    if (error) throw error;

    if (!teacher) {
      return res.status(404).json({
        success: false,
        code: 'ACCOUNT_NOT_FOUND',
        error: `Account does not exist. No teacher record found for "${email}".`
      });
    }

    // No stored password = no login; an admin issues one (POST /api/teachers/:id/reset-password).
    const isValid = !!teacher.password_hash && await verifyPassword(password, teacher.password_hash);
    // If stored as plain text, upgrade to salted hash on successful login
    if (isValid && !teacher.password_hash.includes(':')) {
      await supabase.from('instructors').update({ password_hash: await hashPassword(password) }).eq('id', teacher.id);
    }

    if (!isValid) {
      return res.status(401).json({
        success: false,
        code: 'INCORRECT_PASSWORD',
        error: 'Incorrect password for teacher account.'
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

    if (!isUsernameMatch) {
      return res.status(404).json({
        success: false,
        code: 'ACCOUNT_NOT_FOUND',
        error: 'Invalid administrator username.'
      });
    }

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        code: 'INCORRECT_PASSWORD',
        error: 'Incorrect administrator password.'
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

module.exports = router;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.safeCompare = safeCompare;
module.exports.checkAdminPassword = checkAdminPassword;
