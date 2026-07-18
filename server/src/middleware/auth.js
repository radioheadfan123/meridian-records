const jwt = require('jsonwebtoken');
const { audit } = require('../lib/audit');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role, email: payload.email, name: payload.name };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role guard. Denied attempts are themselves audit events.
function requireRole(...roles) {
  return async (req, res, next) => {
    if (roles.includes(req.user.role)) return next();
    try {
      await audit({
        userId: req.user.id,
        action: 'DENIED',
        patientId: req.params.id || null,
        detail: `${req.method} ${req.originalUrl} requires role ${roles.join('|')}, user has ${req.user.role}`,
        req,
      });
    } catch (e) {
      console.error('Audit write failed on DENIED event', e);
    }
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

module.exports = { requireAuth, requireRole };
