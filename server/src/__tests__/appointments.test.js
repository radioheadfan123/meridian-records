// The scoped scheduling view, tested as an access-control feature rather than a
// CRUD feature. The claim being defended is narrow and specific: front desk gains
// enough to run a calendar (book, reschedule, cancel, read the scheduling reason)
// WITHOUT gaining anything clinical, and provider keeps clinical access without
// gaining the calendar. A test suite that only proved "you can book an
// appointment" would not catch the failure that actually matters here.

jest.mock('../lib/prisma', () => ({
  patient: {
    findUnique: jest.fn(),
  },
  appointment: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const prisma = require('../lib/prisma');
const { encryptField } = require('../lib/crypto');

function auth(role) {
  const token = jwt.sign(
    { sub: `${role.toLowerCase()}-1`, role, email: `${role.toLowerCase()}@demo.clinic`, name: role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  return { Authorization: `Bearer ${token}` };
}

const T0 = new Date('2027-03-01T15:00:00.000Z');

function fakeAppointment(over = {}) {
  return {
    id: 'appt-1',
    patientId: 'patient-1',
    providerId: 'provider-1',
    provider: { id: 'provider-1', name: 'Dr Reyes' },
    visitType: 'FOLLOW_UP',
    reasonEnc: encryptField('follow-up on lab results'),
    startsAt: T0,
    durationMinutes: 30,
    status: 'SCHEDULED',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function deniedCall() {
  return prisma.auditLog.create.mock.calls.find(([arg]) => arg.data.action === 'DENIED');
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.auditLog.create.mockResolvedValue({});
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.patient.findUnique.mockResolvedValue({ id: 'patient-1', firstName: 'Jane', lastName: 'Doe' });
  prisma.appointment.findMany.mockResolvedValue([]);
});

describe('the scoping claim: scheduling context without clinical access', () => {
  test('front desk reads the scheduling reason', async () => {
    prisma.appointment.findMany.mockResolvedValue([fakeAppointment()]);

    const res = await request(app).get('/api/appointments?patientId=patient-1').set(auth('FRONT_DESK'));

    expect(res.status).toBe(200);
    expect(res.body.appointments[0].reason).toBe('follow-up on lab results');
  });

  test('the appointment payload carries no clinical fields for any role', async () => {
    prisma.appointment.findMany.mockResolvedValue([fakeAppointment()]);

    for (const role of ['ADMIN', 'PROVIDER', 'FRONT_DESK']) {
      const res = await request(app).get('/api/appointments').set(auth(role));
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('diagnosis');
      expect(body).not.toContain('medicationHistory');
      expect(body).not.toContain('ssn');
    }
  });

  test('the reason is stored encrypted, never as plaintext', async () => {
    prisma.appointment.create.mockResolvedValue(fakeAppointment());

    await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({
        patientId: 'patient-1',
        visitType: 'FOLLOW_UP',
        startsAt: T0.toISOString(),
        reason: 'follow-up on lab results',
      });

    const written = prisma.appointment.create.mock.calls[0][0].data;
    expect(written.reason).toBeUndefined();
    expect(written.reasonEnc).toEqual(expect.any(String));
    expect(written.reasonEnc).not.toContain('follow-up');
  });
});

describe('who owns the calendar', () => {
  test('provider cannot book, and the refusal is audited as DENIED', async () => {
    const res = await request(app)
      .post('/api/appointments')
      .set(auth('PROVIDER'))
      .send({ patientId: 'patient-1', visitType: 'FOLLOW_UP', startsAt: T0.toISOString() });

    expect(res.status).toBe(403);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
    expect(deniedCall()).toBeTruthy();
  });

  test('provider cannot reschedule', async () => {
    prisma.appointment.findUnique.mockResolvedValue(fakeAppointment());

    const res = await request(app)
      .put('/api/appointments/appt-1')
      .set(auth('PROVIDER'))
      .send({ startsAt: '2027-03-02T15:00:00.000Z' });

    expect(res.status).toBe(403);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(deniedCall()).toBeTruthy();
  });

  test('provider CAN move a visit through its states', async () => {
    prisma.appointment.findUnique.mockResolvedValue(fakeAppointment());
    prisma.appointment.update.mockResolvedValue(fakeAppointment({ status: 'CHECKED_IN' }));

    const res = await request(app)
      .patch('/api/appointments/appt-1/status')
      .set(auth('PROVIDER'))
      .send({ status: 'CHECKED_IN' });

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('CHECKED_IN');
  });

  test('provider cannot cancel, because cancelling is a calendar action', async () => {
    prisma.appointment.findUnique.mockResolvedValue(fakeAppointment());

    const res = await request(app)
      .patch('/api/appointments/appt-1/status')
      .set(auth('PROVIDER'))
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(403);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(deniedCall()).toBeTruthy();
  });

  test('front desk can cancel', async () => {
    prisma.appointment.findUnique.mockResolvedValue(fakeAppointment());
    prisma.appointment.update.mockResolvedValue(fakeAppointment({ status: 'CANCELLED' }));

    const res = await request(app)
      .patch('/api/appointments/appt-1/status')
      .set(auth('FRONT_DESK'))
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('CANCELLED');
  });
});

describe('validation', () => {
  test('an unknown visitType is rejected before anything is written', async () => {
    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({ patientId: 'patient-1', visitType: 'SURGERY', startsAt: T0.toISOString() });

    expect(res.status).toBe(400);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  test('an unparseable startsAt is rejected', async () => {
    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({ patientId: 'patient-1', visitType: 'FOLLOW_UP', startsAt: 'next tuesday-ish' });

    expect(res.status).toBe(400);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  test('an over-long reason is rejected, so this field cannot become a chart note', async () => {
    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({
        patientId: 'patient-1',
        visitType: 'FOLLOW_UP',
        startsAt: T0.toISOString(),
        reason: 'x'.repeat(201),
      });

    expect(res.status).toBe(400);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  test('booking against a missing patient is a 404', async () => {
    prisma.patient.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({ patientId: 'nope', visitType: 'FOLLOW_UP', startsAt: T0.toISOString() });

    expect(res.status).toBe(404);
  });
});

describe('double booking', () => {
  test('an overlapping slot on the same provider is refused', async () => {
    // Existing 15:00-15:30; the new booking starts 15:15.
    prisma.appointment.findMany.mockResolvedValue([fakeAppointment()]);

    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({
        patientId: 'patient-1',
        providerId: 'provider-1',
        visitType: 'URGENT',
        startsAt: '2027-03-01T15:15:00.000Z',
        durationMinutes: 30,
      });

    expect(res.status).toBe(409);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  test('a booking that starts exactly when the previous one ends is allowed', async () => {
    prisma.appointment.findMany.mockResolvedValue([fakeAppointment()]);
    prisma.appointment.create.mockResolvedValue(fakeAppointment({ id: 'appt-2' }));

    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({
        patientId: 'patient-1',
        providerId: 'provider-1',
        visitType: 'FOLLOW_UP',
        startsAt: '2027-03-01T15:30:00.000Z',
        durationMinutes: 30,
      });

    expect(res.status).toBe(201);
  });

  test('a cancelled appointment frees its slot', async () => {
    prisma.appointment.findMany.mockResolvedValue([]); // route filters to active statuses
    prisma.appointment.create.mockResolvedValue(fakeAppointment({ id: 'appt-3' }));

    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({
        patientId: 'patient-1',
        providerId: 'provider-1',
        visitType: 'FOLLOW_UP',
        startsAt: T0.toISOString(),
      });

    expect(res.status).toBe(201);
    expect(prisma.appointment.findMany.mock.calls[0][0].where.status).toEqual({
      in: ['SCHEDULED', 'CHECKED_IN', 'COMPLETED'],
    });
  });

  test('an unassigned slot cannot collide, so no conflict query runs', async () => {
    prisma.appointment.create.mockResolvedValue(fakeAppointment({ providerId: null, provider: null }));

    const res = await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({ patientId: 'patient-1', visitType: 'FOLLOW_UP', startsAt: T0.toISOString() });

    expect(res.status).toBe(201);
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
  });
});

describe('audit coverage', () => {
  test('booking is audited against the patient, naming the appointment fields written', async () => {
    prisma.appointment.create.mockResolvedValue(fakeAppointment());

    await request(app)
      .post('/api/appointments')
      .set(auth('FRONT_DESK'))
      .send({
        patientId: 'patient-1',
        visitType: 'FOLLOW_UP',
        startsAt: T0.toISOString(),
        reason: 'follow-up on lab results',
      });

    const call = prisma.auditLog.create.mock.calls.find(([a]) => a.data.action === 'CREATE');
    expect(call).toBeTruthy();
    expect(call[0].data.patientId).toBe('patient-1');
    expect(call[0].data.fieldsAccessed).toContain('appointment.reason');
  });

  test('a status change records the transition, not just that something changed', async () => {
    prisma.appointment.findUnique.mockResolvedValue(fakeAppointment());
    prisma.appointment.update.mockResolvedValue(fakeAppointment({ status: 'COMPLETED' }));

    await request(app)
      .patch('/api/appointments/appt-1/status')
      .set(auth('ADMIN'))
      .send({ status: 'COMPLETED' });

    const call = prisma.auditLog.create.mock.calls.find(([a]) => a.data.action === 'UPDATE');
    expect(call[0].data.detail).toContain('SCHEDULED -> COMPLETED');
  });
});

describe('authentication', () => {
  test('appointments are behind auth like every other patient route', async () => {
    const res = await request(app).get('/api/appointments');
    expect(res.status).toBe(401);
  });
});
