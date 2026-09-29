// Server-side patient search: every lookup must be audited with the search text,
// and the query must never reach Prisma unvalidated.

jest.mock('../lib/prisma', () => ({
  patient: { findMany: jest.fn() },
  auditLog: { create: jest.fn(), findFirst: jest.fn() },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const prisma = require('../lib/prisma');

const auth = {
  Authorization: `Bearer ${jwt.sign(
    { sub: 'frontdesk-1', role: 'FRONT_DESK', email: 'frontdesk@demo.clinic', name: 'Front Desk' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  )}`,
};

const jane = { id: 'p1', firstName: 'Jane', lastName: 'Doe', dob: new Date('1990-01-01'), phone: '555-0100' };
const loggedDetail = () =>
  prisma.auditLog.create.mock.calls.map(([a]) => a.data).find((d) => d.action === 'LIST').detail;

beforeEach(() => {
  jest.clearAllMocks();
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({});
});

test('no query lists everyone and logs it as a list', async () => {
  prisma.patient.findMany.mockResolvedValue([jane]);
  const res = await request(app).get('/api/patients').set(auth);
  expect(res.status).toBe(200);
  expect(prisma.patient.findMany.mock.calls[0][0].where).toBeUndefined();
  expect(loggedDetail()).toBe('listed 1 patients');
});

test('each word must match a first or last name, case-insensitively', async () => {
  prisma.patient.findMany.mockResolvedValue([jane]);
  await request(app).get('/api/patients?q=jane%20DOE').set(auth);
  const { where } = prisma.patient.findMany.mock.calls[0][0];
  expect(where.AND).toHaveLength(2);
  expect(where.AND[1].OR[1]).toEqual({ lastName: { contains: 'DOE', mode: 'insensitive' } });
});

test('the audit row keeps the exact search text and match count', async () => {
  prisma.patient.findMany.mockResolvedValue([]);
  const res = await request(app).get('/api/patients?q=%20alvarez%20').set(auth);
  expect(res.body.patients).toEqual([]);
  expect(loggedDetail()).toBe('searched "alvarez": 0 matches');
});

test('an over-long search is rejected before it reaches the database', async () => {
  const res = await request(app).get(`/api/patients?q=${'a'.repeat(61)}`).set(auth);
  expect(res.status).toBe(400);
  expect(prisma.patient.findMany).not.toHaveBeenCalled();
});

test('search results still carry demographics only', async () => {
  prisma.patient.findMany.mockResolvedValue([{ ...jane, ssnEnc: 'x', diagnosisEnc: 'y' }]);
  const res = await request(app).get('/api/patients?q=jane').set(auth);
  expect(res.body.patients[0]).not.toHaveProperty('ssnEnc');
  expect(res.body.patients[0]).not.toHaveProperty('diagnosisEnc');
});
