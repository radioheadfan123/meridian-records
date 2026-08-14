// Verifies the RBAC matrix in lib/permissions.js is actually enforced end-to-end:
// forbidden requests get 403 + a DENIED audit row, and GET responses only ever
// contain fields the requester's role is allowed to see.

jest.mock('../lib/prisma', () => ({
  patient: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  breakGlassGrant: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const prisma = require('../lib/prisma');
const { encryptField } = require('../lib/crypto');

function tokenFor(role) {
  return jwt.sign(
    { sub: `${role.toLowerCase()}-1`, role, email: `${role.toLowerCase()}@demo.clinic`, name: role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function auth(role) {
  return { Authorization: `Bearer ${tokenFor(role)}` };
}

function fakePatient() {
  return {
    id: 'patient-1',
    firstName: 'Jane',
    lastName: 'Doe',
    dob: new Date('1990-01-01'),
    phone: '555-0100',
    email: null,
    address: null,
    ssnEnc: encryptField('900-11-2222'),
    diagnosisEnc: encryptField('Type 2 diabetes'),
    medicationHistoryEnc: encryptField('Metformin 500mg'),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function deniedCall() {
  return prisma.auditLog.create.mock.calls.find(([arg]) => arg.data.action === 'DENIED');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('unauthenticated access', () => {
  test('missing token is rejected before any role check', async () => {
    const res = await request(app).get('/api/patients');
    expect(res.status).toBe(401);
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });
});

describe('role-gated routes (requireRole)', () => {
  test('PROVIDER cannot create a patient: 403 + DENIED audit row', async () => {
    const res = await request(app).post('/api/patients').set(auth('PROVIDER')).send({});
    expect(res.status).toBe(403);
    expect(prisma.patient.create).not.toHaveBeenCalled();
    expect(deniedCall()[0].data.detail).toMatch(/requires role ADMIN\|FRONT_DESK/);
  });

  test('FRONT_DESK cannot delete a patient: 403 + DENIED audit row', async () => {
    const res = await request(app).delete('/api/patients/patient-1').set(auth('FRONT_DESK'));
    expect(res.status).toBe(403);
    expect(prisma.patient.delete).not.toHaveBeenCalled();
    expect(deniedCall()[0].data.detail).toMatch(/requires role ADMIN/);
  });

  test('PROVIDER cannot view the audit log: 403 + DENIED audit row', async () => {
    const res = await request(app).get('/api/audit').set(auth('PROVIDER'));
    expect(res.status).toBe(403);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(deniedCall()).toBeTruthy();
  });

  test('ADMIN can create a patient', async () => {
    prisma.patient.create.mockResolvedValue(fakePatient());
    const res = await request(app)
      .post('/api/patients')
      .set(auth('ADMIN'))
      .send({ firstName: 'Jane', lastName: 'Doe', dob: '1990-01-01', phone: '555-0100' });
    expect(res.status).toBe(201);
    expect(prisma.patient.create).toHaveBeenCalled();
  });
});

describe('PUT /:id — per-field allowlist', () => {
  test('PROVIDER cannot update SSN: 403 + DENIED audit row naming the field', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    const res = await request(app).put('/api/patients/patient-1').set(auth('PROVIDER')).send({ ssn: '900-00-0000' });
    expect(res.status).toBe(403);
    expect(prisma.patient.update).not.toHaveBeenCalled();
    expect(deniedCall()[0].data.detail).toMatch(/ssn/);
  });

  test('PROVIDER can update diagnosis: 200 + UPDATE audit row', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    prisma.patient.update.mockResolvedValue(fakePatient());
    const res = await request(app)
      .put('/api/patients/patient-1')
      .set(auth('PROVIDER'))
      .send({ diagnosis: 'Type 2 diabetes, controlled' });
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'UPDATE', fieldsAccessed: ['diagnosis'] }) })
    );
  });
});

describe('GET /:id — field-level redaction', () => {
  test('PROVIDER sees clinical fields but not SSN, and READ audit reflects exactly that', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    const res = await request(app).get('/api/patients/patient-1').set(auth('PROVIDER'));
    expect(res.status).toBe(200);
    expect(res.body.patient.diagnosis).toBe('Type 2 diabetes');
    expect(res.body.patient.medicationHistory).toBe('Metformin 500mg');
    expect(res.body.patient.ssn).toBeUndefined();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'READ', fieldsAccessed: ['diagnosis', 'medicationHistory'] }),
      })
    );
  });

  test('FRONT_DESK sees SSN but not clinical fields, and READ audit reflects exactly that', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    const res = await request(app).get('/api/patients/patient-1').set(auth('FRONT_DESK'));
    expect(res.status).toBe(200);
    expect(res.body.patient.ssn).toBe('900-11-2222');
    expect(res.body.patient.diagnosis).toBeUndefined();
    expect(res.body.patient.medicationHistory).toBeUndefined();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'READ', fieldsAccessed: ['ssn'] }) })
    );
  });

  test('ADMIN sees every sensitive field', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    const res = await request(app).get('/api/patients/patient-1').set(auth('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.patient.ssn).toBe('900-11-2222');
    expect(res.body.patient.diagnosis).toBe('Type 2 diabetes');
    expect(res.body.patient.medicationHistory).toBe('Metformin 500mg');
  });
});

describe('POST /:id/break-glass — emergency access', () => {
  test('rejects a missing reason with 400 and creates no grant', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    const res = await request(app).post('/api/patients/patient-1/break-glass').set(auth('PROVIDER')).send({});
    expect(res.status).toBe(400);
    expect(prisma.breakGlassGrant.create).not.toHaveBeenCalled();
  });

  test('rejects a too-short reason with 400', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    const res = await request(app)
      .post('/api/patients/patient-1/break-glass')
      .set(auth('PROVIDER'))
      .send({ reason: 'why not' });
    expect(res.status).toBe(400);
    expect(prisma.breakGlassGrant.create).not.toHaveBeenCalled();
  });

  test('a valid reason creates a time-limited grant and a loud BREAK_GLASS audit row', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    prisma.breakGlassGrant.create.mockResolvedValue({
      id: 'grant-1',
      reason: 'patient unresponsive in ER, need med history now',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const res = await request(app)
      .post('/api/patients/patient-1/break-glass')
      .set(auth('PROVIDER'))
      .send({ reason: 'patient unresponsive in ER, need med history now' });

    expect(res.status).toBe(201);
    expect(prisma.breakGlassGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: 'patient-1', reason: 'patient unresponsive in ER, need med history now' }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'BREAK_GLASS', patientId: 'patient-1' }) })
    );
  });

  test('GET /:id under an active grant unlocks every sensitive field and logs BREAK_GLASS, not READ', async () => {
    prisma.patient.findUnique.mockResolvedValue(fakePatient());
    prisma.breakGlassGrant.findFirst.mockResolvedValue({
      id: 'grant-1',
      reason: 'emergency override',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const res = await request(app).get('/api/patients/patient-1').set(auth('PROVIDER'));

    expect(res.status).toBe(200);
    expect(res.body.patient.ssn).toBe('900-11-2222'); // normally hidden from PROVIDER
    expect(res.body.breakGlass).toEqual(
      expect.objectContaining({ active: true, reason: 'emergency override' })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'BREAK_GLASS' }) })
    );
  });
});
