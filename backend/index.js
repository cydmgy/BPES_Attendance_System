const path = require('path');
const fs = require('fs');
const backendEnv = path.join(__dirname, '.env');
const rootEnv = path.join(__dirname, '../.env');
if (fs.existsSync(backendEnv)) {
  require('dotenv').config({ path: backendEnv });
} else if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv });
}
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

// ── Route imports ──────────────────────────────────────────────
const authRoutes       = require('./src/routes/auth');
const scanRoutes       = require('./src/routes/scan');
const studentRoutes    = require('./src/routes/students');
const attendanceRoutes = require('./src/routes/attendance');
const overrideRoutes   = require('./src/routes/override');
const leaveRoutes      = require('./src/routes/leave');
const roomsRoutes      = require('./src/routes/rooms');
const subjectsRoutes   = require('./src/routes/subjects');
const teachersRoutes   = require('./src/routes/teachers');
const sectionsRoutes   = require('./src/routes/sections');
const schedulesRoutes  = require('./src/routes/schedules');
const sessionsRoutes   = require('./src/routes/sessions');
const statsRoutes      = require('./src/routes/stats');
const noClassDaysRoutes = require('./src/routes/noClassDays');
const auditRoutes      = require('./src/routes/audit');
const accountRoutes    = require('./src/routes/account');

// The admin password has no built-in fallback: production must not start without one.
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD is not set. Refusing to start in production.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Render puts one proxy in front of us: trust it so each client gets its own rate-limit bucket.
app.set('trust proxy', 1);

// ── Security & Static Assets ────────────────────────────────────
// CSP is report-only in production until the browser console shows no violations, then drop reportOnly.
// The pages use inline onclick= and style=, hence the 'unsafe-inline' entries. Off in dev so CDNs load smoothly.
const cdn = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'];
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...cdn],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", ...cdn, 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://cdnjs.cloudflare.com', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'], // avatars are signed Supabase storage links
      connectSrc: ["'self'"],
    },
  } : false,
}));

// In production: restrict CORS to the deployed origin via ALLOWED_ORIGIN env var.
// Falls back to '*' if ALLOWED_ORIGIN is not yet set (monolith same-origin is safe).
// In development: always allow all origins for local testing convenience.
const corsOrigin = process.env.NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGIN || '*')
  : '*';
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Rate limiter for the IoT scan endpoint ────────────────────
// Tap-to-Enroll polls latest-tap every ~0.8 s from the same IP, so it gets its own bucket.
const isLatestTap = req => req.method === 'GET' && req.path === '/latest-tap';
const scanLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 300,                 // per IP, and every reader shares the school's IP: ~10 rooms tapping at once is 60+/min
  skip: isLatestTap,
  skipFailedRequests: true, // junk/no-key requests (401) must not 429 the real readers
  message: { error: 'Too many requests — slow down' },
});
const latestTapLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
  skip: req => !isLatestTap(req),
  skipFailedRequests: true,
  message: { error: 'Too many requests — slow down' },
});

// ── Rate limiters for logins: failed attempts only, so a busy class logging in is not blocked ──
// Per IP + route + the account field that route reads, so a rotating unrelated field cannot buy a fresh bucket.
const loginMessage = { success: false, error: 'Too many login attempts — try again in a few minutes' };
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  skip: req => /^\/refresh\/*$/i.test(req.path), // refresh needs a valid token, and a school behind one IP must not share a 20-failure budget
  keyGenerator: req => {
    const b = req.body || {};
    const p = req.path.toLowerCase().replace(/\/+$/, ''); // routing ignores case and a trailing slash, so the key must too
    const id = p === '/student' ? b.student_id || b.lrn || b.username : p === '/teacher' ? b.email : b.username || b.full_name;
    return `${ipKeyGenerator(req.ip)}|${p}|${String(id || '').trim().toLowerCase()}`;
  },
  message: loginMessage,
});

// ── Routes ─────────────────────────────────────────────────────
app.use('/api/auth',       authLimiter, authRoutes);
app.use('/api/scan',       scanLimiter, latestTapLimiter, scanRoutes);
app.use('/api/students',   studentRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/override',   overrideRoutes);
app.use('/api/leave',      leaveRoutes);
app.use('/api/rooms',      roomsRoutes);
app.use('/api/subjects',   subjectsRoutes);
app.use('/api/teachers',   teachersRoutes);
app.use('/api/sections',   sectionsRoutes);
app.use('/api/schedules',  schedulesRoutes);
app.use('/api/sessions',   sessionsRoutes);
app.use('/api/stats',      statsRoutes);
app.use('/api/no-class-days', noClassDaysRoutes);
app.use('/api/audit',      auditRoutes);
app.use('/api/account',    accountRoutes);

// ── Health check (also used by ESP32 to verify connectivity) ───
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'online',
    server: 'Attendance System API',
    timestamp: new Date().toISOString(),
  });
});

// Fallback to frontend index.html for non-API routes
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, '../frontend/index.html'));
  }
  next();
});

// ── 404 handler for API routes ─────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nAttendance API running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/ping`);
  console.log(`   IoT scan:     POST http://localhost:${PORT}/api/scan`);
  console.log(`   Frontend UI:  http://localhost:${PORT}/\n`);
});
