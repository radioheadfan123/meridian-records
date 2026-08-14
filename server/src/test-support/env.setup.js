// Dummy env vars so app.js's boot check passes and JWT/crypto have something to work with.
// No real DB or secrets involved — lib/prisma is mocked in every test that needs it.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FIELD_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.CORS_ORIGIN ||= 'http://localhost:5173';
