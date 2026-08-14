jest.mock('../lib/prisma', () => ({
  $queryRaw: jest.fn(),
}));

const request = require('supertest');
const app = require('../app');
const prisma = require('../lib/prisma');

beforeEach(() => {
  jest.clearAllMocks();
});

test('reports healthy when the database is reachable', async () => {
  prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, db: 'ok' });
});

test('reports 503 when the database is unreachable, instead of claiming healthy', async () => {
  prisma.$queryRaw.mockRejectedValue(new Error("Can't reach database server"));
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ ok: false, db: 'unreachable' });
});
