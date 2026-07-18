const express = require('express');
const prisma = require('../lib/prisma');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit?userId=&patientId=&action=&from=&to=&page=&pageSize=
router.get('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { userId, patientId, action, from, to } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 25));

    const where = {};
    if (userId) where.userId = userId;
    if (patientId) where.patientId = patientId;
    if (action) where.action = action;
    if (from || to) {
      where.timestamp = {};
      if (from) where.timestamp.gte = new Date(from);
      if (to) where.timestamp.lte = new Date(to);
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, name: true, email: true, role: true } },
          patient: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    res.json({ logs, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
