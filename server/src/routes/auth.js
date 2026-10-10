const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const passport = require('../config/passport');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { clientIp } = require('../lib/clientIp');
const { PERMISSIONS } = require('../lib/permissions');

const router = express.Router();

// Short-lived access token, held only in the browser's memory. The long-lived part of
// the session is the refresh token, which lives in an httpOnly cookie that page
// JavaScript can't read, so an XSS bug can't walk off with a session that lasts hours.
const ACCESS_TTL = '15m';
const REFRESH_TTL_SECONDS = 8 * 60 * 60; // one clinic shift
const REFRESH_COOKIE = 'mr_refresh';
// Separate secret so a refresh token can never be presented as an access token.
const refreshSecret = () => process.env.JWT_REFRESH_SECRET || `${process.env.JWT_SECRET}:refresh`;

// Secure follows the real request (HTTPS in production via the proxy headers, plain HTTP
// in local dev and tests) rather than trusting NODE_ENV to be set on the host.
const cookieOptions = (req) => ({ httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/api/auth' });

// Tighter limit on login than the global limiter: 10 attempts / 15 min per client.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: 'Too many login attempts, try again later' },
});

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

// ponytail: stateless refresh token, so logout only clears the cookie on this browser.
// A stolen cookie stays valid until it expires. Add a per-user tokenVersion column
// (checked in /refresh, bumped on logout) when server-side revocation matters.
function setRefreshCookie(req, res, user) {
  const refresh = jwt.sign({ sub: user.id, typ: 'refresh' }, refreshSecret(), { expiresIn: REFRESH_TTL_SECONDS });
  res.cookie(REFRESH_COOKIE, refresh, { ...cookieOptions(req), maxAge: REFRESH_TTL_SECONDS * 1000 });
}

function session(user) {
  return {
    token: signAccess(user),
    user: { id: user.id, email: user.email, name: user.name, role: user.role, permissions: PERMISSIONS[user.role] },
  };
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

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
    try {
      await audit({ userId: user.id, action: 'LOGIN', req });
    } catch (e) {
      return next(e);
    }
    setRefreshCookie(req, res, user);
    res.json(session(user));
  })(req, res, next);
});

// Trades the httpOnly cookie for a fresh access token. The user is re-read from the
// database every time, so a role change or a lockout takes effect within one access
// token lifetime instead of lasting the whole refresh window.
router.post('/refresh', async (req, res, next) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (!raw) return res.status(401).json({ error: 'No session' });
  let payload;
  try {
    payload = jwt.verify(raw, refreshSecret());
  } catch {
    res.clearCookie(REFRESH_COOKIE, cookieOptions(req));
    return res.status(401).json({ error: 'Session expired' });
  }
  try {
    const user = payload.typ === 'refresh' ? await prisma.user.findUnique({ where: { id: payload.sub } }) : null;
    if (!user || (user.lockedUntil && user.lockedUntil > new Date())) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions(req));
      return res.status(401).json({ error: 'Session expired' });
    }
    setRefreshCookie(req, res, user); // sliding window: an active shift stays signed in
    res.json(session(user));
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(req));
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, permissions: PERMISSIONS[req.user.role] } });
});

module.exports = router;
