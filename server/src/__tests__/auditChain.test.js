const { GENESIS_HASH, computeHash } = require('../lib/auditHash');

describe('computeHash', () => {
  const base = {
    id: 'row-1',
    userId: 'user-1',
    action: 'READ',
    patientId: 'patient-1',
    fieldsAccessed: ['diagnosis'],
    detail: null,
    ip: '::1',
    timestamp: new Date('2026-08-14T12:00:00.000Z'),
    prevHash: GENESIS_HASH,
  };

  test('is deterministic for identical input', () => {
    expect(computeHash(base)).toBe(computeHash({ ...base }));
  });

  test('changes if any field changes (this is what makes tampering detectable)', () => {
    const original = computeHash(base);
    expect(computeHash({ ...base, detail: 'changed after the fact' })).not.toBe(original);
    expect(computeHash({ ...base, action: 'DENIED' })).not.toBe(original);
    expect(computeHash({ ...base, prevHash: 'a-different-previous-hash' })).not.toBe(original);
  });
});

describe('audit() chains sequential entries', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../lib/prisma', () => ({
      auditLog: { create: jest.fn(), findFirst: jest.fn() },
    }));
  });

  test('first entry chains from GENESIS_HASH, second chains from the first entry\'s hash', async () => {
    const prisma = require('../lib/prisma');
    const { audit } = require('../lib/audit');
    const { computeHash: recompute } = require('../lib/auditHash');

    prisma.auditLog.findFirst.mockResolvedValueOnce(null);
    await audit({ userId: 'user-1', action: 'LOGIN' });
    const firstWrite = prisma.auditLog.create.mock.calls[0][0].data;
    expect(firstWrite.prevHash).toBe(GENESIS_HASH);
    expect(firstWrite.hash).toBe(recompute(firstWrite));

    prisma.auditLog.findFirst.mockResolvedValueOnce({ hash: firstWrite.hash });
    await audit({ userId: 'user-1', action: 'LIST' });
    const secondWrite = prisma.auditLog.create.mock.calls[1][0].data;
    expect(secondWrite.prevHash).toBe(firstWrite.hash);
    expect(secondWrite.hash).toBe(recompute(secondWrite));
  });

  test('a prevHash collision (another writer won the race) is retried against the new tip, not thrown', async () => {
    const prisma = require('../lib/prisma');
    const { audit } = require('../lib/audit');

    // First attempt: reads tip A, but by the time it inserts, someone else already
    // claimed that prevHash - Postgres rejects it via the unique constraint.
    prisma.auditLog.findFirst.mockResolvedValueOnce({ hash: 'tip-A-hash' });
    const collision = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['prevHash'] },
    });
    prisma.auditLog.create.mockRejectedValueOnce(collision);

    // Retry: re-reads the tip, sees it moved to B, succeeds against that instead.
    prisma.auditLog.findFirst.mockResolvedValueOnce({ hash: 'tip-B-hash' });
    prisma.auditLog.create.mockResolvedValueOnce({ id: 'row-final' });

    const result = await audit({ userId: 'user-1', action: 'READ' });

    expect(result).toEqual({ id: 'row-final' });
    expect(prisma.auditLog.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create.mock.calls[1][0].data.prevHash).toBe('tip-B-hash');
  });

  test('a non-collision database error is not retried - it propagates immediately', async () => {
    const prisma = require('../lib/prisma');
    const { audit } = require('../lib/audit');

    prisma.auditLog.findFirst.mockResolvedValue(null);
    prisma.auditLog.create.mockRejectedValue(new Error('connection lost'));

    await expect(audit({ userId: 'user-1', action: 'READ' })).rejects.toThrow('connection lost');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/audit/verify', () => {
  function buildValidChain() {
    const row1Base = {
      id: 'row-1',
      userId: 'user-1',
      action: 'LOGIN',
      patientId: null,
      fieldsAccessed: [],
      detail: null,
      ip: '::1',
      timestamp: new Date('2026-08-14T12:00:00.000Z'),
      prevHash: GENESIS_HASH,
    };
    const row1 = { ...row1Base, hash: computeHash(row1Base) };

    const row2Base = {
      id: 'row-2',
      userId: 'user-1',
      action: 'LIST',
      patientId: null,
      fieldsAccessed: [],
      detail: 'listed 10 patients',
      ip: '::1',
      timestamp: new Date('2026-08-14T12:00:05.000Z'),
      prevHash: row1.hash,
    };
    const row2 = { ...row2Base, hash: computeHash(row2Base) };

    return [row1, row2];
  }

  function auth(role) {
    const jwt = require('jsonwebtoken');
    return {
      Authorization: `Bearer ${jwt.sign(
        { sub: 'admin-1', role, email: 'a@demo.clinic', name: 'A' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      )}`,
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../lib/prisma', () => ({
      auditLog: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    }));
  });

  test('an intact chain reports ok: true', async () => {
    const prisma = require('../lib/prisma');
    const app = require('../app');
    const request = require('supertest');

    prisma.auditLog.findMany.mockResolvedValue(buildValidChain());
    const res = await request(app).get('/api/audit/verify').set(auth('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, total: 2 });
  });

  test('a row edited after the fact breaks the chain and is reported', async () => {
    const prisma = require('../lib/prisma');
    const app = require('../app');
    const request = require('supertest');

    const chain = buildValidChain();
    chain[1].detail = 'listed 999 patients'; // tampered post-hoc, hash no longer matches
    prisma.auditLog.findMany.mockResolvedValue(chain);

    const res = await request(app).get('/api/audit/verify').set(auth('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe('row-2');
    expect(res.body.reason).toMatch(/tampered/);
  });

  test('a legacy row with no hash is reported distinctly from tampering', async () => {
    const prisma = require('../lib/prisma');
    const app = require('../app');
    const request = require('supertest');

    const chain = buildValidChain();
    chain[1].hash = null;
    chain[1].prevHash = null;
    prisma.auditLog.findMany.mockResolvedValue(chain);

    const res = await request(app).get('/api/audit/verify').set(auth('ADMIN'));
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toMatch(/predates/);
  });

  test('a genuinely valid chain still verifies ok even with out-of-order timestamps', async () => {
    // Regression test for a real bug found by live concurrency bursts against Supabase:
    // the verify route used to trust `orderBy: timestamp asc` to reflect true chain
    // order. It doesn't have to - under concurrent writes, the row that actually won the
    // race to claim a given prevHash isn't necessarily the row whose timestamp is
    // earliest (clock reads and write-order aren't the same thing). That made a
    // perfectly valid chain report as broken. Walking the actual hash pointers instead
    // of the timestamp column is what fixes it; this proves the fix, not just that
    // hashing works.
    const prisma = require('../lib/prisma');
    const app = require('../app');
    const request = require('supertest');

    const [row1] = buildValidChain();
    const row2Base = {
      id: 'row-2b',
      userId: 'user-2',
      action: 'READ',
      patientId: 'patient-9',
      fieldsAccessed: ['ssn'],
      detail: null,
      ip: '::1',
      timestamp: new Date('2026-08-14T11:00:00.000Z'), // earlier than row1, on purpose
      prevHash: row1.hash, // but genuinely chains from row1
    };
    const row2 = { ...row2Base, hash: computeHash(row2Base) };

    prisma.auditLog.findMany.mockResolvedValue([row1, row2]);
    const res = await request(app).get('/api/audit/verify').set(auth('ADMIN'));
    expect(res.body).toEqual({ ok: true, total: 2 });
  });

  test('two rows both claiming the same prevHash (a fork) is detected', async () => {
    const prisma = require('../lib/prisma');
    const app = require('../app');
    const request = require('supertest');

    const [row1] = buildValidChain();
    const childBase = {
      userId: 'user-2',
      action: 'READ',
      patientId: 'patient-9',
      fieldsAccessed: ['ssn'],
      detail: null,
      ip: '::1',
      timestamp: new Date('2026-08-14T12:00:10.000Z'),
      prevHash: row1.hash,
    };
    const childA = { ...childBase, id: 'row-2a', hash: computeHash({ ...childBase, id: 'row-2a' }) };
    const childB = { ...childBase, id: 'row-2b', hash: computeHash({ ...childBase, id: 'row-2b' }) };

    prisma.auditLog.findMany.mockResolvedValue([row1, childA, childB]);
    const res = await request(app).get('/api/audit/verify').set(auth('ADMIN'));
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toMatch(/forked/);
  });

  test('non-ADMIN roles cannot call verify', async () => {
    const app = require('../app');
    const request = require('supertest');
    const res = await request(app).get('/api/audit/verify').set(auth('PROVIDER'));
    expect(res.status).toBe(403);
  });

  // Regression guard for the bug found 2026-09-02. AuditLog.patientId used to be a
  // foreign key with onDelete: SetNull, so deleting a patient silently rewrote
  // patientId to NULL on their audit rows. The hash covers patientId, so verify then
  // reported real tampering that nobody had done.
  //
  // This is asserted against the schema text rather than through the API because the
  // damage happens inside Postgres, on a table the app never updates - there is no
  // application code path a mocked-Prisma test could exercise to catch it. The schema
  // IS the guarantee here, so the schema is what gets checked.
  // Comments are stripped before asserting: the model carries a long comment that
  // explains the old bug and therefore contains the words "SetNull" and "@relation".
  // Matching prose instead of code is how a guard like this quietly stops guarding.
  function auditModelCode() {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    return schema
      .match(/model AuditLog \{[\s\S]*?\n\}/)[0]
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  test('patientId is not a mutable foreign key, or a deletion would rewrite history', () => {
    const code = auditModelCode();

    expect(code).toMatch(/patientId\s+String\?/);
    // No relation field pointing at Patient. The `user` relation is left alone on
    // purpose: it carries no cascading action, so a delete is refused rather than
    // silently rewriting a hashed row.
    expect(code).not.toMatch(/patient\s+Patient/);
    expect(code).not.toMatch(/references:\s*\[id\][^)]*\)\s*\/\/?\s*$|Patient/);
  });

  test('no cascading delete action may touch a hashed row', () => {
    // If a future change adds one, the chain silently starts lying about tampering.
    // Cheap to assert, expensive to discover.
    expect(auditModelCode()).not.toMatch(/onDelete:\s*(SetNull|Cascade|SetDefault)/);
  });
});
