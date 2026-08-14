// Key rotation, step 2: after adding a new FIELD_ENCRYPTION_KEY_V<n> alongside the
// old key(s), new writes already use it (crypto.js always picks the highest version).
// This migrates EXISTING rows so old ciphertext isn't left depending on a key you may
// eventually want to retire. Safe to run repeatedly - rows already on the latest
// version are skipped. Not part of the running app - run manually:
//
//   node scripts/reencrypt-to-latest.js           (dry run, writes nothing)
//   node scripts/reencrypt-to-latest.js --apply    (writes the re-encrypted fields)
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { encryptField, decryptField, storedVersion, currentActiveVersion } = require('../src/lib/crypto');

const ENC_COLUMN = {
  ssn: 'ssnEnc',
  diagnosis: 'diagnosisEnc',
  medicationHistory: 'medicationHistoryEnc',
};

async function main() {
  const apply = process.argv.includes('--apply');
  const target = currentActiveVersion();
  console.log(`Active key version: v${target}`);

  const patients = await prisma.patient.findMany();
  let touchedPatients = 0;
  let rewrittenFields = 0;

  for (const patient of patients) {
    const data = {};
    for (const [field, column] of Object.entries(ENC_COLUMN)) {
      const stored = patient[column];
      if (!stored) continue;
      if (storedVersion(stored) === target) continue;
      data[column] = encryptField(decryptField(stored));
      rewrittenFields++;
    }

    if (Object.keys(data).length === 0) continue;
    touchedPatients++;
    console.log(
      `${apply ? 'writing' : '[dry run]'} ${patient.id} (${patient.lastName}, ${patient.firstName}): ${Object.keys(data).join(', ')}`
    );
    if (apply) {
      await prisma.patient.update({ where: { id: patient.id }, data });
    }
  }

  if (touchedPatients === 0) {
    console.log(`Nothing to do - every field is already on v${target}.`);
    return;
  }
  console.log(
    `${apply ? 'Re-encrypted' : 'Would re-encrypt'} ${rewrittenFields} field(s) across ${touchedPatients} patient(s) to v${target}.`
  );
  if (!apply) console.log('Re-run with --apply to write these.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
