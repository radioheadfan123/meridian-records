const crypto = require('crypto');
const prisma = require('./prisma');
const { GENESIS_HASH, computeHash } = require('./auditHash');

// Concurrent writers race to read "the current chain tip" and both can try to chain
// from it. An advisory lock was tried first but isn't reliable here: this app connects
// through Supabase's pgbouncer in transaction-pooling mode, which PgBouncer's own docs
// call out as not reliably supporting session-scoped locking primitives - confirmed
// live, where a lock-protected version still forked under a real concurrency burst.
// The correctness guarantee that actually holds regardless of pooling is the
// `@@unique([prevHash])` constraint in schema.prisma: Postgres itself rejects a second
// row claiming the same prevHash. This is the standard optimistic-retry pattern for
// that: on a collision, re-read the (now different) tip and try again.
const MAX_RETRIES = 10;

function isPrevHashCollision(err) {
  return err?.code === 'P2002' && err?.meta?.target?.includes('prevHash');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every read and write of a patient record goes through here.
// Awaited by callers so a failed audit write fails the request:
// under HIPAA, an unauditable access should not happen silently.
async function audit({ userId, action, patientId = null, fieldsAccessed = [], detail = null, req = null }) {
  const ip = req ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null) : null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const id = crypto.randomUUID();
    const timestamp = new Date();

    try {
      const prev = await prisma.auditLog.findFirst({ orderBy: { timestamp: 'desc' }, select: { hash: true } });
      const prevHash = prev?.hash ?? GENESIS_HASH;
      const hash = computeHash({ id, userId, action, patientId, fieldsAccessed, detail, ip, timestamp, prevHash });

      return await prisma.auditLog.create({
        data: { id, userId, action, patientId, fieldsAccessed, detail, ip, timestamp, prevHash, hash },
      });
    } catch (err) {
      if (!isPrevHashCollision(err) || attempt >= MAX_RETRIES) throw err;
      // Jittered backoff: every retrier waking up at the same instant just recreates
      // the collision. A small random delay spreads them out so contention resolves
      // instead of repeating.
      await sleep(Math.random() * 15 * attempt);
    }
  }
}

module.exports = { audit };
