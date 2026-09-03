// One-time repair for damage the old `onDelete: SetNull` foreign key did to the
// audit hash chain.
//
// What happened: AuditLog.patientId used to be a foreign key with onDelete SetNull.
// Deleting a patient therefore rewrote patientId to NULL on every audit row that
// referenced them. The hash covers patientId, so those rows stopped matching their
// own stored hash and /api/audit/verify reported them as tampered. It was right to:
// the rows genuinely were modified after they were written. The cause was a second
// feature holding a reference it was allowed to mutate, not an attacker.
//
// The foreign key is gone now (see schema.prisma), so this cannot happen again, and
// this script exists only to repair the rows already damaged. It is NOT a routine
// tool. Re-hashing audit rows is exactly the operation the chain exists to detect,
// so it stays a deliberate, manual, dry-run-by-default action rather than anything
// the app can do on its own.
//
// Because each hash feeds the next row's prevHash, repairing a row forces every row
// after it to be re-chained too. The script therefore rewrites from the FIRST
// mismatch to the end, and refuses to run at all if it finds a mismatch it cannot
// explain by this specific bug (a row whose patientId is NULL for an action that
// normally carries one). That guard is the point: it repairs known damage and still
// fails loudly on anything that looks like real tampering.
//
//   node scripts/rechain-audit-after-setnull.js           (dry run, writes nothing)
//   node scripts/rechain-audit-after-setnull.js --apply   (rewrites the chain)

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { GENESIS_HASH, computeHash } = require('../src/lib/auditHash');

// Actions that always record a patient when one was involved. A NULL here on one of
// these is the fingerprint of the SetNull bug rather than of an edited row.
const PATIENT_ACTIONS = ['READ', 'CREATE', 'UPDATE', 'DELETE', 'BREAK_GLASS'];

function fieldsOf(row) {
  return {
    id: row.id,
    userId: row.userId,
    action: row.action,
    patientId: row.patientId,
    fieldsAccessed: row.fieldsAccessed,
    detail: row.detail,
    ip: row.ip,
    timestamp: row.timestamp,
    prevHash: row.prevHash,
  };
}

// Walks prevHash -> hash links rather than trusting timestamps, matching what
// /api/audit/verify does. Write order and wall-clock order are not the same thing
// under concurrency, and the pointers are the real order.
function chainOrder(rows) {
  const byPrevHash = new Map();
  for (const r of rows) {
    if (r.hash && r.prevHash) byPrevHash.set(r.prevHash, r);
  }
  const ordered = [];
  let current = byPrevHash.get(GENESIS_HASH);
  while (current) {
    ordered.push(current);
    current = byPrevHash.get(current.hash);
  }
  return ordered;
}

async function main() {
  const apply = process.argv.includes('--apply');

  const rows = await prisma.auditLog.findMany({ orderBy: [{ timestamp: 'asc' }, { id: 'asc' }] });
  const ordered = chainOrder(rows);

  if (ordered.length === 0) {
    console.log('No chained rows found. Run backfill-audit-hashes.js first.');
    return;
  }
  console.log(`${rows.length} audit rows, ${ordered.length} reachable by following the chain.`);

  const mismatches = ordered.filter((r) => computeHash(fieldsOf(r)) !== r.hash);
  if (mismatches.length === 0) {
    console.log('Chain already verifies. Nothing to do.');
    return;
  }

  console.log(`\n${mismatches.length} row(s) do not match their own stored hash:`);
  for (const r of mismatches) {
    const explained = r.patientId === null && PATIENT_ACTIONS.includes(r.action);
    console.log(
      `  ${r.timestamp.toISOString()}  ${r.action.padEnd(11)} patientId=${r.patientId}  ` +
        `${explained ? 'EXPLAINED by the SetNull bug' : 'UNEXPLAINED'}`
    );
    if (r.detail) console.log(`      detail: ${r.detail}`);
  }

  const unexplained = mismatches.filter(
    (r) => !(r.patientId === null && PATIENT_ACTIONS.includes(r.action))
  );
  if (unexplained.length > 0) {
    console.error(
      `\nREFUSING TO RUN: ${unexplained.length} mismatch(es) are not explained by the SetNull bug.\n` +
        'Those rows were altered some other way and this script will not paper over that.\n' +
        'Investigate them before re-chaining anything.'
    );
    process.exitCode = 1;
    return;
  }

  // Repair from the first mismatch onward: everything after it inherits a new prevHash.
  const firstBad = ordered.findIndex((r) => computeHash(fieldsOf(r)) !== r.hash);
  const tail = ordered.slice(firstBad);
  console.log(
    `\nFirst mismatch is row ${firstBad + 1} of ${ordered.length}, so ${tail.length} row(s) get re-chained.`
  );

  let prevHash = firstBad === 0 ? GENESIS_HASH : ordered[firstBad - 1].hash;
  const updates = [];
  for (const row of tail) {
    const hash = computeHash({ ...fieldsOf(row), prevHash });
    updates.push({ id: row.id, prevHash, hash });
    prevHash = hash;
  }

  if (!apply) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply to rewrite the chain.');
    return;
  }

  // One transaction: a half-rewritten chain is worse than a broken one. Passing an
  // array (not an interactive callback) keeps this working through Supabase's
  // transaction-mode pooler, which is the same constraint that shaped lib/audit.js.
  await prisma.$transaction(
    updates.map((u) =>
      prisma.auditLog.update({ where: { id: u.id }, data: { prevHash: u.prevHash, hash: u.hash } })
    )
  );
  console.log(`\nRe-chained ${updates.length} row(s). Confirm with GET /api/audit/verify.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
