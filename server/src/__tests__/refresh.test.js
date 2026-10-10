// Cookie session: login sets an httpOnly refresh cookie, /refresh trades it for a new
// access token, and the refresh token can never stand in for an access token.

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
const user = {
  id: 'user-1',
  email: 'provider@demo.clinic',
  passwordHash: bcrypt.hashSync(PASSWORD, 10),
  name: 'Dr. Priya Provider',
  role: 'PROVIDER',
  failedAttempts: 0,
  lockedUntil: null,
};

const refreshCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('mr_refresh='));

async function login() {
  prisma.user.findUnique.mockResolvedValue(user);
  return request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
}

beforeEach(() => jest.clearAllMocks());

test('login sets an httpOnly, SameSite=Strict refresh cookie scoped to /api/auth', async () => {
  const res = await login();
  expect(res.status).toBe(200);
  const c = refreshCookie(res);
  expect(c).toMatch(/HttpOnly/);
  expect(c).toMatch(/SameSite=Strict/);
  expect(c).toMatch(/Path=\/api\/auth/);
});

test('refresh with the cookie returns a working access token and rotates the cookie', async () => {
  const cookie = refreshCookie(await login()).split(';')[0];
  prisma.user.findUnique.mockResolvedValue({ ...user, role: 'ADMIN' }); // role changed since login
  const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
  expect(res.status).toBe(200);
  expect(res.body.user.role).toBe('ADMIN'); // re-read from the DB, not copied from the old token
  expect(refreshCookie(res)).toBeTruthy();
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
  expect(me.status).toBe(200);
});

test('refresh without a cookie, or with a garbage one, is 401', async () => {
  expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
  expect((await request(app).post('/api/auth/refresh').set('Cookie', 'mr_refresh=nope')).status).toBe(401);
});

test('a locked or deleted account cannot refresh', async () => {
  const cookie = refreshCookie(await login()).split(';')[0];
  prisma.user.findUnique.mockResolvedValue({ ...user, lockedUntil: new Date(Date.now() + 60_000) });
  expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  prisma.user.findUnique.mockResolvedValue(null);
  expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
});

test('the refresh token is rejected as a Bearer access token', async () => {
  const value = refreshCookie(await login()).split(';')[0].split('=')[1];
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${value}`);
  expect(res.status).toBe(401);
});

test('logout clears the cookie', async () => {
  const res = await request(app).post('/api/auth/logout');
  expect(res.status).toBe(204);
  expect(refreshCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
});
