// Create and update reject bad field values with a 400 and a readable message, before
// anything is written. Before this, a junk date crashed with a 500 and a birth date in
// 2999 or a phone of "abc" was saved as-is.

jest.mock('../lib/prisma', () => ({
  patient: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn(), findFirst: jest.fn() },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const prisma = require('../lib/prisma');

const auth = {
  Authorization: `Bearer ${jwt.sign(
    { sub: 'admin-1', role: 'ADMIN', email: 'admin@demo.clinic', name: 'Admin' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  )}`,
};
const good = { firstName: 'Jane', lastName: 'Doe', dob: '1990-01-01', phone: '555-0100', ssn: '900-12-3456' };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({});
  prisma.patient.create.mockResolvedValue({ id: 'p1', ...good, dob: new Date(good.dob) });
  prisma.patient.findUnique.mockResolvedValue({ id: 'p1', ...good, dob: new Date(good.dob) });
  prisma.patient.update.mockResolvedValue({ id: 'p1', ...good, dob: new Date(good.dob) });
});

test('a valid patient is created', async () => {
  const res = await request(app).post('/api/patients').set(auth).send(good);
  expect(res.status).toBe(201);
});

test.each([
  ['dob', 'not a date', /valid date/],
  ['dob', '2999-01-01', /between 1900 and today/],
  ['phone', 'abc', /Phone should look like/],
  ['ssn', 'hello', /SSN should look like/],
  ['email', 'nope', /Email should look like/],
  ['firstName', '   ', /First name is required/],
  ['firstName', 'x'.repeat(101), /too long/],
  ['lastName', { $ne: 1 }, /must be text/],
])('create rejects %s = %p', async (field, value, msg) => {
  const res = await request(app).post('/api/patients').set(auth).send({ ...good, [field]: value });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(msg);
  expect(prisma.patient.create).not.toHaveBeenCalled();
});

test('update rejects a blanked required field and writes nothing', async () => {
  const res = await request(app).put('/api/patients/p1').set(auth).send({ lastName: '' });
  expect(res.status).toBe(400);
  expect(prisma.patient.update).not.toHaveBeenCalled();
});

test('update can clear an optional field', async () => {
  const res = await request(app).put('/api/patients/p1').set(auth).send({ email: '' });
  expect(res.status).toBe(200);
});
