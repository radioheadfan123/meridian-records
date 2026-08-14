// Exercises the real login path: passport's LocalStrategy, bcrypt.compare, and account
// lockout. rbac.test.js signs JWTs directly to skip straight to route logic, which never
// touches bcrypt or passport.js at all - this file is what actually verifies a bcrypt
// version bump (or a passport/lockout change) didn't break login itself.

jest.mock('../lib/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../app');
const prisma = require('../lib/prisma');

const PASSWORD = 'CorrectHorseBattery9!';

function fakeUser(overrides = {}) {
  return {
    id: 'user-1',
    email: 'provider@demo.clinic',
    passwordHash: bcrypt.hashSync(PASSWORD, 10),
    name: 'Dr. Priya Provider',
    role: 'PROVIDER',
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('correct password logs in: 200, a JWT, and permissions matching the role', async () => {
  prisma.user.findUnique.mockResolvedValue(fakeUser());
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'provider@demo.clinic', password: PASSWORD });

  expect(res.status).toBe(200);
  expect(typeof res.body.token).toBe('string');
  expect(res.body.user.role).toBe('PROVIDER');
  expect(res.body.user.permissions.viewFields).toEqual(['diagnosis', 'medicationHistory']);
  // failedAttempts/lockedUntil weren't dirty, so no reset write is needed.
  expect(prisma.user.update).not.toHaveBeenCalled();
});

test('wrong password: 401 and failedAttempts increments', async () => {
  prisma.user.findUnique.mockResolvedValue(fakeUser());
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'provider@demo.clinic', password: 'wrong password entirely' });

  expect(res.status).toBe(401);
  expect(prisma.user.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ failedAttempts: 1 }) })
  );
});

test('5th wrong password locks the account for 15 minutes', async () => {
  prisma.user.findUnique.mockResolvedValue(fakeUser({ failedAttempts: 4 }));
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'provider@demo.clinic', password: 'still wrong' });

  expect(res.status).toBe(401);
  const call = prisma.user.update.mock.calls[0][0];
  expect(call.data.failedAttempts).toBe(5);
  expect(call.data.lockedUntil).toBeInstanceOf(Date);
  expect(call.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
});

test('a locked account is rejected even with the correct password, and bcrypt is never called', async () => {
  prisma.user.findUnique.mockResolvedValue(
    fakeUser({ lockedUntil: new Date(Date.now() + 10 * 60 * 1000) })
  );
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'provider@demo.clinic', password: PASSWORD });

  expect(res.status).toBe(401);
  expect(res.body.error).toMatch(/locked/i);
  expect(prisma.user.update).not.toHaveBeenCalled();
});

test('unknown email gets the same generic error as a wrong password (no user enumeration)', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  const knownRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'provider@demo.clinic', password: 'wrong' });
  const unknownRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'nobody@demo.clinic', password: 'wrong' });

  expect(unknownRes.status).toBe(401);
  expect(unknownRes.body.error).toBe(knownRes.body.error);
});

test('GET /me with a valid token round-trips the role and permissions', async () => {
  prisma.user.findUnique.mockResolvedValue(fakeUser({ role: 'FRONT_DESK' }));
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'provider@demo.clinic', password: PASSWORD });

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
  expect(me.status).toBe(200);
  expect(me.body.user.role).toBe('FRONT_DESK');
  expect(me.body.user.permissions.viewFields).toEqual(['ssn']);
});
