const express = require('express');
const prisma = require('../lib/prisma');
const { encryptField, decryptField } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { requireRole } = require('../middleware/auth');
const { PERMISSIONS, SENSITIVE_FIELDS, DEMOGRAPHIC_FIELDS } = require('../lib/permissions');

const router = express.Router();

const ENC_COLUMN = {
  ssn: 'ssnEnc',
  diagnosis: 'diagnosisEnc',
  medicationHistory: 'medicationHistoryEnc',
};

const BREAK_GLASS_MINUTES = 15;

function demographics(p) {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    dob: p.dob,
    phone: p.phone,
    email: p.email,
    address: p.address,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// GET /api/patients — all roles, demographics only, never decrypts anything.
router.get('/', async (req, res, next) => {
  try {
    const patients = await prisma.patient.findMany({ orderBy: { lastName: 'asc' } });
    await audit({ userId: req.user.id, action: 'LIST', detail: `listed ${patients.length} patients`, req });
    res.json({ patients: patients.map(demographics) });
  } catch (err) {
    next(err);
  }
});

// GET /api/patients/:id — sensitive fields are decrypted only if the role may view them,
// unless the requester holds an active break-glass grant for this patient, in which case
// every sensitive field unlocks and the read itself is logged as BREAK_GLASS, not READ.
// The rule: never decrypt what you won't return.
router.get('/:id', async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const grant = await prisma.breakGlassGrant.findFirst({
      where: { userId: req.user.id, patientId: patient.id, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
    });

    const viewable = grant ? SENSITIVE_FIELDS : PERMISSIONS[req.user.role].viewFields;
    const result = demographics(patient);
    const decrypted = [];

    for (const field of SENSITIVE_FIELDS) {
      if (viewable.includes(field)) {
        result[field] = decryptField(patient[ENC_COLUMN[field]]);
        decrypted.push(field);
      }
    }

    await audit({
      userId: req.user.id,
      action: grant ? 'BREAK_GLASS' : 'READ',
      patientId: patient.id,
      fieldsAccessed: decrypted,
      detail: grant ? `read under active emergency access grant (reason: ${grant.reason})` : null,
      req,
    });
    res.json({
      patient: result,
      breakGlass: grant ? { active: true, reason: grant.reason, expiresAt: grant.expiresAt } : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/patients/:id/break-glass — any authenticated role. Emergency override: a
// mandatory reason, a short time-limited grant, and a loud BREAK_GLASS audit entry so
// admins can review every use. This bypasses the normal field allowlist by design —
// accountability (the reason + audit trail), not restriction, is the safeguard here.
router.post('/:id/break-glass', async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const reason = (req.body.reason || '').trim();
    if (reason.length < 10) {
      return res.status(400).json({ error: 'A reason of at least 10 characters is required for emergency access' });
    }

    const expiresAt = new Date(Date.now() + BREAK_GLASS_MINUTES * 60 * 1000);
    const grant = await prisma.breakGlassGrant.create({
      data: { userId: req.user.id, patientId: patient.id, reason, expiresAt },
    });

    await audit({
      userId: req.user.id,
      action: 'BREAK_GLASS',
      patientId: patient.id,
      fieldsAccessed: SENSITIVE_FIELDS,
      detail: `emergency access granted for ${BREAK_GLASS_MINUTES} min, reason: ${reason}`,
      req,
    });

    res.status(201).json({ grant: { id: grant.id, expiresAt: grant.expiresAt, reason: grant.reason } });
  } catch (err) {
    next(err);
  }
});

// POST /api/patients — admin and front desk.
router.post('/', requireRole('ADMIN', 'FRONT_DESK'), async (req, res, next) => {
  try {
    const { firstName, lastName, dob, phone, email, address, ssn, diagnosis, medicationHistory } = req.body;
    if (!firstName || !lastName || !dob || !phone) {
      return res.status(400).json({ error: 'firstName, lastName, dob and phone are required' });
    }

    // Front desk can set SSN at intake but not clinical fields.
    const updatable = PERMISSIONS[req.user.role].updateFields;
    if ((diagnosis !== undefined || medicationHistory !== undefined) && !updatable.includes('diagnosis')) {
      await audit({ userId: req.user.id, action: 'DENIED', detail: 'attempted to set clinical fields on create', req });
      return res.status(403).json({ error: 'Your role cannot set clinical fields' });
    }

    const written = [];
    const data = { firstName, lastName, dob: new Date(dob), phone, email: email || null, address: address || null };
    if (ssn !== undefined) { data.ssnEnc = encryptField(ssn); written.push('ssn'); }
    if (diagnosis !== undefined) { data.diagnosisEnc = encryptField(diagnosis); written.push('diagnosis'); }
    if (medicationHistory !== undefined) { data.medicationHistoryEnc = encryptField(medicationHistory); written.push('medicationHistory'); }

    const patient = await prisma.patient.create({ data });
    await audit({ userId: req.user.id, action: 'CREATE', patientId: patient.id, fieldsAccessed: written, req });
    res.status(201).json({ patient: demographics(patient) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/patients/:id — partial update, every field checked against the role's allowlist.
router.put('/:id', async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const updatable = PERMISSIONS[req.user.role].updateFields;
    const attempted = Object.keys(req.body).filter((k) =>
      [...DEMOGRAPHIC_FIELDS, ...SENSITIVE_FIELDS].includes(k)
    );
    if (attempted.length === 0) return res.status(400).json({ error: 'No updatable fields in request' });

    const forbidden = attempted.filter((k) => !updatable.includes(k));
    if (forbidden.length > 0) {
      await audit({
        userId: req.user.id,
        action: 'DENIED',
        patientId: patient.id,
        detail: `attempted to update forbidden fields: ${forbidden.join(', ')}`,
        req,
      });
      return res.status(403).json({ error: `Your role cannot update: ${forbidden.join(', ')}` });
    }

    const data = {};
    for (const k of attempted) {
      if (SENSITIVE_FIELDS.includes(k)) data[ENC_COLUMN[k]] = encryptField(req.body[k]);
      else if (k === 'dob') data.dob = new Date(req.body.dob);
      else data[k] = req.body[k];
    }

    const updated = await prisma.patient.update({ where: { id: patient.id }, data });
    await audit({ userId: req.user.id, action: 'UPDATE', patientId: patient.id, fieldsAccessed: attempted, req });
    res.json({ patient: demographics(updated) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/patients/:id — admin only. Audit rows survive via onDelete: SetNull.
router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    // Log first so the row still carries the patientId reference at write time,
    // then the FK is nulled by the delete (name preserved in detail).
    await audit({
      userId: req.user.id,
      action: 'DELETE',
      patientId: patient.id,
      detail: `deleted patient ${patient.firstName} ${patient.lastName}`,
      req,
    });
    await prisma.patient.delete({ where: { id: patient.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
