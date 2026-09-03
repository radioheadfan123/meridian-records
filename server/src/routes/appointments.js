// Scoped scheduling view.
//
// The README used to admit that role access here was a binary field block: a role
// either saw a clinical field or it did not. That left the front desk unable to run
// a calendar without handing them the clinical record, which is the exact thing
// minimum-necessary is supposed to prevent. An appointment is the narrower object
// that fixes it - visit category, short scheduling reason, time, status - so the
// front desk gets what scheduling actually needs and still never sees a diagnosis.
//
// Every rule below is read from lib/permissions.js. Nothing here invents its own.

const express = require('express');
const prisma = require('../lib/prisma');
const { encryptField, decryptField } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { PERMISSIONS } = require('../lib/permissions');

const router = express.Router();

const VISIT_TYPES = [
  'NEW_PATIENT',
  'FOLLOW_UP',
  'ANNUAL_PHYSICAL',
  'LAB_REVIEW',
  'VACCINATION',
  'TELEHEALTH',
  'URGENT',
];
const STATUSES = ['SCHEDULED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

// A scheduling note is a sentence, not a chart entry. The cap is a guard against
// this field quietly becoming the place people paste clinical history.
const MAX_REASON = 200;
const MIN_DURATION = 5;
const MAX_DURATION = 480;

// Statuses that still occupy a slot on the calendar. A cancelled or no-show visit
// frees its time, so it must not block a rebooking.
const ACTIVE_STATUSES = ['SCHEDULED', 'CHECKED_IN', 'COMPLETED'];

async function denied(req, detail, patientId = null) {
  await audit({ userId: req.user.id, action: 'DENIED', patientId, detail, req });
}

// Shapes an appointment for the wire. `reason` is decrypted only for roles allowed
// to read it - the same "never decrypt what you won't return" rule the patient
// routes follow, applied to the scheduling slice.
function present(appt, canViewReason) {
  const out = {
    id: appt.id,
    patientId: appt.patientId,
    providerId: appt.providerId,
    provider: appt.provider ? { id: appt.provider.id, name: appt.provider.name } : null,
    visitType: appt.visitType,
    startsAt: appt.startsAt,
    durationMinutes: appt.durationMinutes,
    status: appt.status,
    createdAt: appt.createdAt,
    updatedAt: appt.updatedAt,
  };
  if (canViewReason) out.reason = decryptField(appt.reasonEnc);
  return out;
}

function parseStartsAt(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Validates the writable body of a booking or a reschedule. Returns { error } or { data }.
function buildWritableData(body, { partial = false } = {}) {
  const data = {};

  if (body.visitType !== undefined) {
    if (!VISIT_TYPES.includes(body.visitType)) {
      return { error: `visitType must be one of: ${VISIT_TYPES.join(', ')}` };
    }
    data.visitType = body.visitType;
  } else if (!partial) {
    return { error: 'visitType is required' };
  }

  if (body.startsAt !== undefined) {
    const startsAt = parseStartsAt(body.startsAt);
    if (!startsAt) return { error: 'startsAt must be a valid date' };
    data.startsAt = startsAt;
  } else if (!partial) {
    return { error: 'startsAt is required' };
  }

  if (body.durationMinutes !== undefined) {
    const n = Number(body.durationMinutes);
    if (!Number.isInteger(n) || n < MIN_DURATION || n > MAX_DURATION) {
      return { error: `durationMinutes must be an integer between ${MIN_DURATION} and ${MAX_DURATION}` };
    }
    data.durationMinutes = n;
  }

  if (body.providerId !== undefined) data.providerId = body.providerId || null;

  if (body.reason !== undefined) {
    const reason = (body.reason || '').trim();
    if (reason.length > MAX_REASON) {
      return { error: `reason must be ${MAX_REASON} characters or fewer` };
    }
    data.reasonEnc = reason ? encryptField(reason) : null;
  }

  return { data };
}

// Overlap check for a provider's calendar.
//
// ponytail: application-level check, so two concurrent bookings can both pass it
// and double-book. The durable fix is a Postgres exclusion constraint over
// (providerId, tstzrange(startsAt, startsAt + durationMinutes)) with btree_gist,
// which Prisma cannot express and would need a raw migration. Worth doing if this
// ever books real patients; this is the same app-check-vs-database-constraint
// lesson the audit hash chain already learned the hard way.
async function conflictFor({ providerId, startsAt, durationMinutes, excludeId = null }) {
  if (!providerId) return null; // unassigned slots cannot collide with a clinician
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);

  const candidates = await prisma.appointment.findMany({
    where: {
      providerId,
      status: { in: ACTIVE_STATUSES },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startsAt: { lt: endsAt },
    },
  });

  // Prisma cannot compare startsAt + durationMinutes in the query, so the closing
  // half of the overlap test happens here, over the narrow set the query returned.
  return (
    candidates.find(
      (c) => new Date(c.startsAt.getTime() + c.durationMinutes * 60 * 1000) > startsAt
    ) || null
  );
}

// GET /api/appointments?patientId=&from=&to= — any role with view rights.
router.get('/', async (req, res, next) => {
  try {
    const perms = PERMISSIONS[req.user.role].appointments;
    if (!perms.view) {
      await denied(req, 'attempted to list appointments');
      return res.status(403).json({ error: 'Your role cannot view appointments' });
    }

    const where = {};
    if (req.query.patientId) where.patientId = req.query.patientId;
    if (req.query.from || req.query.to) {
      where.startsAt = {};
      if (req.query.from) {
        const from = parseStartsAt(req.query.from);
        if (!from) return res.status(400).json({ error: 'from must be a valid date' });
        where.startsAt.gte = from;
      }
      if (req.query.to) {
        const to = parseStartsAt(req.query.to);
        if (!to) return res.status(400).json({ error: 'to must be a valid date' });
        where.startsAt.lte = to;
      }
    }

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      include: { provider: true },
    });

    await audit({
      userId: req.user.id,
      action: 'LIST',
      patientId: req.query.patientId || null,
      fieldsAccessed: perms.viewReason ? ['appointment.reason'] : [],
      detail: `listed ${appointments.length} appointment(s)`,
      req,
    });

    res.json({ appointments: appointments.map((a) => present(a, perms.viewReason)) });
  } catch (err) {
    next(err);
  }
});

// POST /api/appointments — book. Front desk and admin only.
router.post('/', async (req, res, next) => {
  try {
    const perms = PERMISSIONS[req.user.role].appointments;
    if (!perms.schedule) {
      await denied(req, 'attempted to book an appointment', req.body.patientId || null);
      return res.status(403).json({ error: 'Your role cannot book appointments' });
    }

    const { patientId } = req.body;
    if (!patientId) return res.status(400).json({ error: 'patientId is required' });

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const { error, data } = buildWritableData(req.body);
    if (error) return res.status(400).json({ error });

    const clash = await conflictFor({
      providerId: data.providerId ?? null,
      startsAt: data.startsAt,
      durationMinutes: data.durationMinutes ?? 30,
    });
    if (clash) {
      return res.status(409).json({ error: 'That provider already has an appointment overlapping this time' });
    }

    const appointment = await prisma.appointment.create({
      data: { ...data, patientId },
      include: { provider: true },
    });

    await audit({
      userId: req.user.id,
      action: 'CREATE',
      patientId,
      fieldsAccessed: Object.keys(data).map((k) => `appointment.${k === 'reasonEnc' ? 'reason' : k}`),
      detail: `booked ${appointment.visitType} appointment for ${appointment.startsAt.toISOString()}`,
      req,
    });

    res.status(201).json({ appointment: present(appointment, perms.viewReason) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/appointments/:id — reschedule or amend. Front desk and admin only.
router.put('/:id', async (req, res, next) => {
  try {
    const perms = PERMISSIONS[req.user.role].appointments;
    const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Appointment not found' });

    if (!perms.schedule) {
      await denied(req, 'attempted to reschedule an appointment', existing.patientId);
      return res.status(403).json({ error: 'Your role cannot reschedule appointments' });
    }

    const { error, data } = buildWritableData(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No updatable appointment fields in request' });
    }

    const clash = await conflictFor({
      providerId: data.providerId !== undefined ? data.providerId : existing.providerId,
      startsAt: data.startsAt ?? existing.startsAt,
      durationMinutes: data.durationMinutes ?? existing.durationMinutes,
      excludeId: existing.id,
    });
    if (clash) {
      return res.status(409).json({ error: 'That provider already has an appointment overlapping this time' });
    }

    const appointment = await prisma.appointment.update({
      where: { id: existing.id },
      data,
      include: { provider: true },
    });

    await audit({
      userId: req.user.id,
      action: 'UPDATE',
      patientId: appointment.patientId,
      fieldsAccessed: Object.keys(data).map((k) => `appointment.${k === 'reasonEnc' ? 'reason' : k}`),
      detail: `updated appointment ${appointment.id}`,
      req,
    });

    res.json({ appointment: present(appointment, perms.viewReason) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/appointments/:id/status — move a visit through its states.
// Providers may check in / complete / no-show, because that half of scheduling is
// genuinely theirs, but cancelling is a calendar action and needs `cancel`.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const perms = PERMISSIONS[req.user.role].appointments;
    const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Appointment not found' });

    const { status } = req.body;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }

    const needed = status === 'CANCELLED' ? perms.cancel : perms.setStatus;
    if (!needed) {
      await denied(req, `attempted to set appointment status to ${status}`, existing.patientId);
      return res.status(403).json({ error: `Your role cannot set an appointment to ${status}` });
    }

    const appointment = await prisma.appointment.update({
      where: { id: existing.id },
      data: { status },
      include: { provider: true },
    });

    await audit({
      userId: req.user.id,
      action: 'UPDATE',
      patientId: appointment.patientId,
      fieldsAccessed: ['appointment.status'],
      detail: `appointment ${appointment.id} status ${existing.status} -> ${status}`,
      req,
    });

    res.json({ appointment: present(appointment, perms.viewReason) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
