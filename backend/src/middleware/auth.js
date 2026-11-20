// Middleware: dashboard auth. Only signed session tokens are accepted: Authorization: Bearer att.<payload_b64>.<sig_b64>
// (issued by /api/auth/*). No dev tokens, no bypass flags, no third-party JWTs: behaviour must not depend on NODE_ENV.

const { verifyToken } = require('../utils/token');

module.exports = function auth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — no token provided' });
  }

  const token = authHeader.split(' ')[1];
  if (!token || !token.startsWith('att.')) {
    return res.status(401).json({ error: 'Unauthorized — invalid token' });
  }

  const verification = verifyToken(token);
  if (!verification.valid) {
    return res.status(401).json({
      error: `Unauthorized — ${verification.error || 'invalid or expired session'}`
    });
  }

  req.user = {
    ...verification.payload,
    id: verification.payload.id || verification.payload.student_id || verification.payload.instructor_id
  };
  return next();
};
