const express = require('express');
const prisma = require('../lib/prisma');
const { requireRole } = require('../middleware/auth');
const { GENESIS_HASH, computeHash } = require('../lib/auditHash');
const { findAnomalies } = require('../lib/anomalies');
const { audit } = require('../lib/audit');

const router = express.Router();

const ACTIONS = ['LOGIN', 'LOGIN_FAILED', 'LIST', 'READ', 'CREATE', 'UPDATE', 'DELETE', 'DENIED', 'BREAK_GLASS'];

// Shared by the paged viewer and the CSV export so both filter identically.
// An unknown action or an unparseable date is a 400, not a silently ignored filter.
function buildWhere(query) {
  const { userId, patientId, action, from, to } = query;
  const where = {};
  if (userId) where.userId = String(userId);
  if (patientId) where.patientId = String(patientId);
  if (action) {
    if (!ACTIONS.includes(action)) throw Object.assign(new Error('Unknown action filter'), { status: 400 });
    where.action = action;
  }
  if (from || to) {
    where.timestamp = {};
    for (const [k, v] of [['gte', from], ['lte', to]]) {
      if (!v) continue;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw Object.assign(new Error('Invalid date filter'), { status: 400 });
      where.timestamp[k] = d;
    }
  }
  return where;
}

async function patientNames(logs) {
  const ids = [...new Set(logs.map((l) => l.patientId).filter(Boolean))];
  const patients = ids.length
    ? await prisma.patient.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  return new Map(patients.map((p) => [p.id, p]));
}

// GET /api/audit?userId=&patientId=&action=&from=&to=&page=&pageSize=
router.get('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 25));

    const where = buildWhere(req.query);

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, name: true, email: true, role: true } },
        },
      }),
    ]);

    // patientId is no longer a foreign key (see schema.prisma: an append-only,
    // tamper-evident row must not hold a reference another operation can rewrite),
    // so the patient name is resolved here instead of joined. Ids that no longer
    // resolve belong to deleted patients - the audit row deliberately keeps the id
    // anyway, and the DELETE row's own detail text carries the name.
    const byId = await patientNames(logs);

    res.json({
      logs: logs.map((l) => ({ ...l, patient: l.patientId ? byId.get(l.patientId) ?? null : null })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// GET /api/audit/anomalies?days=7 - see lib/anomalies.js for what gets flagged and why.
router.get('/anomalies', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.auditLog.findMany({
      where: { timestamp: { gte: since } },
      select: { userId: true, action: true, patientId: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    });
    const flags = findAnomalies(rows);
    const ids = [...new Set(flags.map((f) => f.userId))];
    const users = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, email: true, role: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json({ days, scanned: rows.length, flags: flags.map((f) => ({ ...f, user: byId.get(f.userId) ?? null })) });
  } catch (err) {
    next(err);
  }
});

// Spreadsheet apps execute cells that start with = + - @ (CSV/formula injection), and
// detail text can contain user-typed input like a break-glass reason. Prefixing a quote
// makes those cells plain text. Every cell is quoted so commas and newlines survive.
function csvCell(v) {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const EXPORT_CAP = 10000;

// GET /api/audit/export - same filters as the viewer, as CSV, newest first.
// Exporting the audit trail is itself a sensitive act (it leaves the system), so it is
// logged. There's no EXPORT action in the enum and adding one is a schema migration, so
// it goes in as LIST - the closest honest fit, a bulk read of many rows - with the
// filter and row count spelled out in detail.
router.get('/export', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const where = buildWhere(req.query);
    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: EXPORT_CAP,
      include: { user: { select: { name: true, email: true, role: true } } },
    });
    const byId = await patientNames(logs);

    const header = ['timestamp', 'action', 'user_name', 'user_email', 'user_role', 'patient_id', 'patient_name',
      'fields_accessed', 'detail', 'ip', 'prev_hash', 'hash'];
    const lines = [header.map(csvCell).join(',')];
    for (const l of logs) {
      const p = l.patientId ? byId.get(l.patientId) : null;
      lines.push([
        l.timestamp, l.action, l.user?.name, l.user?.email, l.user?.role, l.patientId,
        p ? `${p.lastName}, ${p.firstName}` : l.patientId ? '(deleted)' : '',
        l.fieldsAccessed.join(';'), l.detail, l.ip, l.prevHash, l.hash,
      ].map(csvCell).join(','));
    }

    await audit({
      userId: req.user.id,
      action: 'LIST',
      detail: `exported ${logs.length} audit rows to CSV${logs.length === EXPORT_CAP ? ' (capped)' : ''}; filter ${JSON.stringify(req.query).slice(0, 300)}`,
      req,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`);
    res.send(lines.join('\r\n') + '\r\n');
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
