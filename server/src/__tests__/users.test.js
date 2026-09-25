// Staff account list and lockout unlock (routes/users.js).

jest.mock('../lib/prisma', () => ({
  user: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn(), findFirst: jest.fn() },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const prisma = require('../lib/prisma');

const auth = (role) => ({
  Authorization: `Bearer ${jwt.sign({ sub: `${role.toLowerCase()}-1`, role, email: 'x@demo.clinic', name: role }, process.env.JWT_SECRET)}`,
});
const auditRows = () => prisma.auditLog.create.mock.calls.map(([a]) => a.data);

beforeEach(() => jest.clearAllMocks());

test('lists accounts with a computed locked flag', async () => {
  prisma.user.findMany.mockResolvedValue([
    { id: 'u1', name: 'A', email: 'a@x', role: 'PROVIDER', failedAttempts: 5, lockedUntil: new Date(Date.now() + 60000) },
    { id: 'u2', name: 'B', email: 'b@x', role: 'FRONT_DESK', failedAttempts: 2, lockedUntil: new Date(Date.now() - 60000) },
  ]);
  const res = await request(app).get('/api/users').set(auth('ADMIN'));
  expect(res.status).toBe(200);
  expect(res.body.users.map((u) => u.locked)).toEqual([true, false]);
  expect(res.body.users[0].passwordHash).toBeUndefined();
});

test('unlock clears the lockout and logs what it was', async () => {
  const until = new Date(Date.now() + 10 * 60000);
  prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'provider@demo.clinic', failedAttempts: 5, lockedUntil: until });
  const res = await request(app).post('/api/users/u1/unlock').set(auth('ADMIN'));
  expect(res.status).toBe(200);
  expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { failedAttempts: 0, lockedUntil: null } });
  const row = auditRows().find((d) => d.action === 'UPDATE');
  expect(row.detail).toBe(`unlocked staff account provider@demo.clinic (5 failed attempts, was locked until ${until.toISOString()})`);
  expect(row.patientId).toBeNull();
});

test('unknown user is 404 and nothing is written', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  expect((await request(app).post('/api/users/nope/unlock').set(auth('ADMIN'))).status).toBe(404);
  expect(prisma.user.update).not.toHaveBeenCalled();
});

test('non-admin is denied, and the DENIED row does not put a staff id in patientId', async () => {
  const res = await request(app).post('/api/users/u1/unlock').set(auth('FRONT_DESK'));
  expect(res.status).toBe(403);
  const denied = auditRows().find((d) => d.action === 'DENIED');
  expect(denied.patientId).toBeNull();
  expect(prisma.user.update).not.toHaveBeenCalled();
});
