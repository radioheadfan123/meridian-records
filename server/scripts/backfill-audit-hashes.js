// One-time backfill: rows written before the hash-chain feature existed have no
// hash/prevHash. This walks them in timestamp order and chains them retroactively,
// so GET /api/audit/verify covers full history instead of only rows written after
// this feature shipped. Not part of the running app - run manually, once, after the
// schema push that added the columns:
//
//   node scripts/backfill-audit-hashes.js           (dry run, writes nothing)
//   node scripts/backfill-audit-hashes.js --apply    (writes the computed hashes)
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { GENESIS_HASH, computeHash } = require('../src/lib/auditHash');

async function main() {
  const apply = process.argv.includes('--apply');

  const rows = await prisma.auditLog.findMany({ orderBy: [{ timestamp: 'asc' }, { id: 'asc' }] });
  const unhashed = rows.filter((r) => !r.hash || !r.prevHash);

  console.log(`${rows.length} total rows, ${unhashed.length} need backfilling.`);
  if (unhashed.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let expectedPrev = GENESIS_HASH;
  let written = 0;
  for (const row of rows) {
    // Rows that already have a hash (written after this feature shipped) are left
    // alone; we just carry their hash forward as the chain continues past them.
    if (row.hash && row.prevHash) {
      if (row.prevHash !== expectedPrev) {
        throw new Error(
          `Row ${row.id} already has prevHash ${row.prevHash} but the backfill chain expected ${expectedPrev}. ` +
            `Stopping - do not run this against a DB where new rows were written out of timestamp order relative to old ones.`
        );
      }
      expectedPrev = row.hash;
      continue;
    }

    const prevHash = expectedPrev;
    const hash = computeHash({
      id: row.id,
      userId: row.userId,
      action: row.action,
      patientId: row.patientId,
      fieldsAccessed: row.fieldsAccessed,
      detail: row.detail,
      ip: row.ip,
      timestamp: row.timestamp,
      prevHash,
    });

    console.log(`${apply ? 'writing' : '[dry run]'} ${row.id} (${row.action} @ ${row.timestamp.toISOString()})`);
    if (apply) {
      await prisma.auditLog.update({ where: { id: row.id }, data: { prevHash, hash } });
    }
    expectedPrev = hash;
    written++;
  }

  console.log(`${apply ? 'Backfilled' : 'Would backfill'} ${written} rows.`);
  if (!apply) console.log('Re-run with --apply to write these hashes.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
