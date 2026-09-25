// Audit anomaly flags (lib/anomalies.js) and the /anomalies and /export routes.

jest.mock('../lib/prisma', () => ({
  patient: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  auditLog: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const prisma = require('../lib/prisma');
const { findAnomalies } = require('../lib/anomalies');

const auth = (role) => ({
  Authorization: `Bearer ${jwt.sign({ sub: `${role.toLowerCase()}-1`, role, email: 'x@demo.clinic', name: role }, process.env.JWT_SECRET)}`,
});

// 2026-09-01 is a Tuesday; 15:00Z is 10:00 in Chicago (CDT, UTC-5).
const at = (min, hourZ = 15) => new Date(Date.UTC(2026, 8, 1, hourZ, min)).toISOString();
const row = (userId, action, min, patientId = null, hourZ) => ({ userId, action, patientId, timestamp: at(min, hourZ) });

beforeEach(() => jest.clearAllMocks());

describe('findAnomalies', () => {
  test('flags 8 distinct charts in an hour, not 7', () => {
    const eight = Array.from({ length: 8 }, (_, i) => row('u1', 'READ', i * 5, `p${i}`));
    expect(findAnomalies(eight).map((f) => f.type)).toEqual(['BULK_READ']);
    expect(findAnomalies(eight.slice(0, 7))).toEqual([]);
  });

  test('bulk read counts distinct patients, so re-opening one chart is not bulk', () => {
    const same = Array.from({ length: 20 }, (_, i) => row('u1', 'READ', i, 'p1'));
    expect(findAnomalies(same)).toEqual([]);
  });

  test('reads spread over more than an hour do not add up', () => {
    const spread = Array.from({ length: 8 }, (_, i) => row('u1', 'READ', i * 10, `p${i}`));
    // 8 reads 10 minutes apart span 70 minutes: the peak window holds 7
    expect(findAnomalies(spread)).toEqual([]);
  });

  test('3 DENIED in an hour is flagged, and each user is judged alone', () => {
    const rows = [row('u1', 'DENIED', 0), row('u1', 'DENIED', 10), row('u2', 'DENIED', 20), row('u1', 'DENIED', 30)];
    const flags = findAnomalies(rows);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ type: 'REPEATED_DENIED', userId: 'u1', count: 3 });
  });

  test('failed logins burst is flagged', () => {
    const rows = [0, 5, 9].map((m) => row('u1', 'LOGIN_FAILED', m));
    expect(findAnomalies(rows)[0]).toMatchObject({ type: 'FAILED_LOGINS', count: 3 });
  });

  test('off-hours uses clinic local time, and only chart access counts', () => {
    // 04:00Z = 23:00 Chicago the night before
    const rows = [row('u1', 'READ', 0, 'p1', 4), row('u1', 'LOGIN', 0, null, 4), row('u2', 'READ', 0, 'p1', 15)];
    const flags = findAnomalies(rows);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ type: 'OFF_HOURS', userId: 'u1', count: 1 });
  });

  test('high severity sorts first', () => {
    const rows = [
      row('u2', 'READ', 0, 'p1', 4),
      ...Array.from({ length: 9 }, (_, i) => row('u1', 'READ', i, `p${i}`)),
    ];
    expect(findAnomalies(rows).map((f) => f.severity)).toEqual(['high', 'low']);
  });
});

describe('GET /api/audit/anomalies', () => {
  test('is ADMIN only, and the refusal is audited', async () => {
    const res = await request(app).get('/api/audit/anomalies').set(auth('PROVIDER'));
    expect(res.status).toBe(403);
    expect(prisma.auditLog.create.mock.calls.some(([a]) => a.data.action === 'DENIED')).toBe(true);
  });

  test('returns flags with the user attached', async () => {
    prisma.auditLog.findMany.mockResolvedValue(Array.from({ length: 8 }, (_, i) => row('u1', 'READ', i, `p${i}`)));
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Dr. Demo', email: 'provider@demo.clinic', role: 'PROVIDER' }]);
    const res = await request(app).get('/api/audit/anomalies?days=500').set(auth('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
    expect(res.body.flags[0]).toMatchObject({ type: 'BULK_READ', user: { name: 'Dr. Demo' } });
  });
});

describe('GET /api/audit/export', () => {
  const logRow = (over = {}) => ({
    id: 'a1', userId: 'u1', action: 'BREAK_GLASS', patientId: 'p1', fieldsAccessed: ['ssn', 'diagnosis'],
    detail: 'reason: unresponsive, "code blue"', ip: '::1', timestamp: new Date('2026-09-01T15:00:00Z'),
    prevHash: 'h0', hash: 'h1', user: { name: 'Dr. Demo', email: 'provider@demo.clinic', role: 'PROVIDER' }, ...over,
  });

  test('returns quoted CSV and logs the export itself', async () => {
    prisma.auditLog.findMany.mockResolvedValue([logRow()]);
    prisma.patient.findMany.mockResolvedValue([{ id: 'p1', firstName: 'Jane', lastName: 'Doe' }]);
    const res = await request(app).get('/api/audit/export?action=BREAK_GLASS').set(auth('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-log-/);
    const [header, line] = res.text.trim().split('\r\n');
    expect(header.startsWith('"timestamp","action"')).toBe(true);
    expect(line).toContain('"Doe, Jane"');
    expect(line).toContain('"ssn;diagnosis"');
    expect(line).toContain('"reason: unresponsive, ""code blue"""');
    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({ action: 'BREAK_GLASS' });
    const logged = prisma.auditLog.create.mock.calls.map(([a]) => a.data).find((d) => d.action === 'LIST');
    expect(logged.detail).toMatch(/^exported 1 audit rows to CSV/);
  });

  test('neutralises spreadsheet formulas in user-supplied text', async () => {
    prisma.auditLog.findMany.mockResolvedValue([logRow({ detail: '=HYPERLINK("http://evil","x")' })]);
    prisma.patient.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/audit/export').set(auth('ADMIN'));
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(res.text).toContain('"(deleted)"');
  });

  test('bad filters are a 400, not ignored', async () => {
    expect((await request(app).get('/api/audit/export?action=DROP').set(auth('ADMIN'))).status).toBe(400);
    expect((await request(app).get('/api/audit/export?from=notadate').set(auth('ADMIN'))).status).toBe(400);
    expect((await request(app).get('/api/audit?action=DROP').set(auth('ADMIN'))).status).toBe(400);
  });

  test('FRONT_DESK cannot export', async () => {
    expect((await request(app).get('/api/audit/export').set(auth('FRONT_DESK'))).status).toBe(403);
  });
});
