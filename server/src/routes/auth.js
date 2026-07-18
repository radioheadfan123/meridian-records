const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const passport = require('../config/passport');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { PERMISSIONS } = require('../lib/permissions');

const router = express.Router();

// Tighter limit on login than the global limiter: 10 attempts / 15 min per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

router.post('/login', loginLimiter, (req, res, next) => {
  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      // Log failed attempts against the account when we know which one it was.
      if (info?.userId) {
        try {
          await audit({ userId: info.userId, action: 'LOGIN_FAILED', detail: info.locked ? 'locked' : 'bad password', req });
        } catch (e) {
          console.error('Audit write failed', e);
        }
      }
      return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    }
    const token = jwt.sign(
      { sub: user.id, role: user.role, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    try {
      await audit({ userId: user.id, action: 'LOGIN', req });
    } catch (e) {
      return next(e);
    }
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, permissions: PERMISSIONS[user.role] },
    });
  })(req, res, next);
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, permissions: PERMISSIONS[req.user.role] } });
});

module.exports = router;
