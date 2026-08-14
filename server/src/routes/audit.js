const express = require('express');
const prisma = require('../lib/prisma');
const { requireRole } = require('../middleware/auth');
const { GENESIS_HASH, computeHash } = require('../lib/auditHash');

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

// GET /api/audit/verify — walks the hash chain by following prevHash -> hash links,
// starting from GENESIS_HASH, rather than trusting the timestamp column to reflect
// write order. It doesn't: under concurrent writes, two requests can generate their
// timestamps in one order but commit (and therefore actually get chained) in the
// other, since the timestamp is a wall-clock read and the chain order is decided by
// which request wins the advisory lock in lib/audit.js. Walking the real pointers is
// correct regardless of what any timestamp says. Any row altered, deleted-and-
// reinserted, forked (two rows both claiming the same prevHash), or predating this
// feature (never backfilled) breaks or forks the chain, which is the point: append-only
// is a promise the API keeps, this is what lets an admin confirm the promise was kept.
router.get('/verify', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany();
    const total = logs.length;
    if (total === 0) return res.json({ ok: true, total: 0 });

    const byPrevHash = new Map();
    for (const row of logs) {
      if (!row.hash || !row.prevHash) {
        return res.json({
          ok: false,
          total,
          brokenAt: row.id,
          reason: 'row has no hash (predates the hash-chain feature and was never backfilled)',
        });
      }
      if (byPrevHash.has(row.prevHash)) {
        return res.json({
          ok: false,
          total,
          brokenAt: row.id,
          reason: `chain forked: two rows both claim prevHash ${row.prevHash}`,
        });
      }
      byPrevHash.set(row.prevHash, row);
    }

    let checked = 0;
    let current = byPrevHash.get(GENESIS_HASH);
    if (!current) {
      return res.json({ ok: false, total, checked: 0, reason: 'no row chains from GENESIS_HASH (chain has no valid start)' });
    }

    while (current) {
      const recomputed = computeHash({
        id: current.id,
        userId: current.userId,
        action: current.action,
        patientId: current.patientId,
        fieldsAccessed: current.fieldsAccessed,
        detail: current.detail,
        ip: current.ip,
        timestamp: current.timestamp,
        prevHash: current.prevHash,
      });
      if (recomputed !== current.hash) {
        return res.json({
          ok: false,
          total,
          checked,
          brokenAt: current.id,
          reason: 'stored hash does not match a recomputation of this row\'s own contents (tampered)',
        });
      }
      checked++;
      current = byPrevHash.get(current.hash);
    }

    if (checked !== total) {
      return res.json({
        ok: false,
        total,
        checked,
        reason: `${total - checked} row(s) are not reachable by following the chain from genesis (orphaned)`,
      });
    }

    res.json({ ok: true, total });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
