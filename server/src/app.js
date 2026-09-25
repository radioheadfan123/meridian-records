require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const passport = require('./config/passport');
const { requireAuth } = require('./middleware/auth');
const prisma = require('./lib/prisma');

const authRoutes = require('./routes/auth');
const patientRoutes = require('./routes/patients');
const auditRoutes = require('./routes/audit');
const appointmentRoutes = require('./routes/appointments');
const userRoutes = require('./routes/users');

for (const v of ['DATABASE_URL', 'JWT_SECRET']) {
  if (!process.env[v]) {
    console.error(`Missing required env var: ${v}`);
    process.exit(1);
  }
}

// At least one field-encryption key must be present: FIELD_ENCRYPTION_KEY (version 1,
// unchanged from before key rotation existed) or any FIELD_ENCRYPTION_KEY_V<n>.
if (!process.env.FIELD_ENCRYPTION_KEY && !Object.keys(process.env).some((k) => /^FIELD_ENCRYPTION_KEY_V\d+$/.test(k))) {
  console.error('Missing required env var: FIELD_ENCRYPTION_KEY (or FIELD_ENCRYPTION_KEY_V<n>)');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Railway/Render sit behind a proxy

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : 'http://localhost:5173',
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(passport.initialize());

// Global limiter: 300 requests / 15 min per IP. Login has its own stricter one.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Verifies the app can actually reach Postgres, not just that the process is up -
// a health check that only proves the event loop is alive isn't worth much to a monitor.
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: 'ok' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'unreachable' });
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/patients', requireAuth, patientRoutes);
app.use('/api/appointments', requireAuth, appointmentRoutes);
app.use('/api/audit', requireAuth, auditRoutes);
app.use('/api/users', requireAuth, userRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler. Never leak stack traces or field contents.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
