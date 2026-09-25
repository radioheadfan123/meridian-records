const express = require('express');
const prisma = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// The param is :userId, not :id, on purpose. requireRole writes req.params.id into the
// DENIED row's patientId, which is right on /patients/:id and would be wrong here - a
// staff account id would land in the patient column of the audit log.

// GET /api/users - staff accounts and their lockout state. No PHI here, so listing
// isn't audited; changing an account is.
router.get('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, role: true, failedAttempts: true, lockedUntil: true, createdAt: true },
    });
    const now = new Date();
    res.json({ users: users.map((u) => ({ ...u, locked: !!u.lockedUntil && u.lockedUntil > now })) });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:userId/unlock - clears a lockout early. The lockout (5 bad passwords,
// 15 minutes) exists to slow guessing, so lifting it is logged with what it was.
router.post('/:userId/unlock', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    await prisma.user.update({
      where: { id: target.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    const wasLocked = target.lockedUntil && target.lockedUntil > new Date();
    await audit({
      userId: req.user.id,
      action: 'UPDATE',
      detail: `unlocked staff account ${target.email} (${target.failedAttempts} failed attempts${
        wasLocked ? `, was locked until ${target.lockedUntil.toISOString()}` : ', not locked'
      })`,
      req,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
