require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const passport = require('./config/passport');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const patientRoutes = require('./routes/patients');
const auditRoutes = require('./routes/audit');

for (const v of ['DATABASE_URL', 'JWT_SECRET', 'FIELD_ENCRYPTION_KEY']) {
  if (!process.env[v]) {
    console.error(`Missing required env var: ${v}`);
    process.exit(1);
  }
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

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/patients', requireAuth, patientRoutes);
app.use('/api/audit', requireAuth, auditRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler. Never leak stack traces or field contents.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
