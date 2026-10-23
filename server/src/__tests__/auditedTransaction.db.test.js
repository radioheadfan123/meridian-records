// Patient writes and their audit rows commit together, against a REAL Postgres.
// Mocked Prisma can't show this: rollback and the prevHash unique constraint live in
// the database. Runs only when server/.env points at a local database (never a hosted
// one), so CI and any machine without the local copy skip it.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envFile = path.join(__dirname, '../../.env');
const env = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL || '');
if (local) Object.assign(process.env, env);

const run = local ? describe : describe.skip;

run('audited patient writes (local Postgres)', () => {
  let app, prisma, request, jwt, adminId;
  const tag = `Txtest${Date.now()}`; // lastName marker so cleanup only touches this run's rows

  function auth(sub) {
    return {
      Authorization: `Bearer ${jwt.sign({ sub, role: 'ADMIN', email: 'admin@demo.clinic', name: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`,
    };
  }
  const patient = (i) => ({ firstName: `P${i}`, lastName: tag, dob: '1990-01-01', phone: '555-0100' });

  beforeAll(async () => {
    app = require('../app');
    prisma = require('../lib/prisma');
    request = require('supertest');
    jwt = require('jsonwebtoken');
    adminId = (await prisma.user.findUnique({ where: { email: 'admin@demo.clinic' } })).id;
  });

  afterAll(async () => {
    // Through the API so the deletes are audited like any other.
    const left = await prisma.patient.findMany({ where: { lastName: tag } });
    for (const p of left) await request(app).delete(`/api/patients/${p.id}`).set(auth(adminId));
    await prisma.$disconnect();
  });

  test('a failed audit write rolls back the patient it was recording', async () => {
    // A user id with no User row: the patient insert succeeds, then the audit row's
    // foreign key fails. Before the transaction, the patient stayed behind.
    jest.spyOn(console, 'error').mockImplementation(() => {}); // the expected 500 is logged
    const res = await request(app).post('/api/patients').set(auth('00000000-0000-0000-0000-000000000000')).send(patient('ghost'));
    expect(res.status).toBe(500);
    expect(await prisma.patient.count({ where: { lastName: tag } })).toBe(0);
  });

  test('concurrent creates all land, each with one CREATE row, and the chain stays valid', async () => {
    const n = 12;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => request(app).post('/api/patients').set(auth(adminId)).send(patient(i)))
    );
    expect(results.map((r) => r.status)).toEqual(Array(n).fill(201));

    const ids = results.map((r) => r.body.patient.id);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE', patientId: { in: ids } } })).toBe(n);

    const verify = await request(app).get('/api/audit/verify').set(auth(adminId));
    expect(verify.body.ok).toBe(true);
  }, 30000);

  test('delete removes the patient and writes its DELETE row together', async () => {
    const created = await request(app).post('/api/patients').set(auth(adminId)).send(patient('del'));
    const id = created.body.patient.id;
    const res = await request(app).delete(`/api/patients/${id}`).set(auth(adminId));
    expect(res.status).toBe(200);
    expect(await prisma.patient.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'DELETE', patientId: id } })).toBe(1);
  });
});
