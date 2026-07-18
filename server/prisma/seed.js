// Seeds demo users and SYNTHETIC patients. Every value here is fake.
// SSNs use the 900-999 area range, which the SSA never issues.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { encryptField } = require('../src/lib/crypto');

const prisma = new PrismaClient();

const USERS = [
  { email: 'admin@demo.clinic', name: 'Ava Admin', role: 'ADMIN', password: 'AdminDemo123!' },
  { email: 'provider@demo.clinic', name: 'Dr. Priya Provider', role: 'PROVIDER', password: 'ProviderDemo123!' },
  { email: 'frontdesk@demo.clinic', name: 'Frank Frontdesk', role: 'FRONT_DESK', password: 'FrontdeskDemo123!' },
];

const PATIENTS = [
  ['Maria', 'Alvarez', '1987-03-14', '555-0101', 'Type 2 diabetes', 'Metformin 500mg BID'],
  ['James', 'Baker', '1954-11-02', '555-0102', 'Hypertension', 'Lisinopril 10mg daily'],
  ['Chen', 'Dawson', '1990-07-22', '555-0103', 'Seasonal allergies', 'Loratadine 10mg PRN'],
  ['Fatima', 'El-Sayed', '1976-01-30', '555-0104', 'Asthma, mild persistent', 'Albuterol inhaler PRN; Fluticasone daily'],
  ['George', 'Feld', '1969-09-09', '555-0105', 'Hyperlipidemia', 'Atorvastatin 20mg nightly'],
  ['Hana', 'Ito', '2001-05-18', '555-0106', 'Migraine without aura', 'Sumatriptan 50mg PRN'],
  ['Kwame', 'Johnson', '1982-12-25', '555-0107', 'GERD', 'Omeprazole 20mg daily'],
  ['Lena', 'Kovacs', '1995-04-06', '555-0108', 'Generalized anxiety disorder', 'Sertraline 50mg daily'],
  ['Omar', 'Mansour', '1948-08-13', '555-0109', 'Osteoarthritis, bilateral knees', 'Acetaminophen 650mg PRN'],
  ['Ruth', 'Nakamura', '1972-06-27', '555-0110', 'Hypothyroidism', 'Levothyroxine 75mcg daily'],
];

async function main() {
  for (const u of USERS) {
    const passwordHash = await bcrypt.hash(u.password, 12);
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, name: u.name, role: u.role, passwordHash },
    });
  }

  const count = await prisma.patient.count();
  if (count === 0) {
    for (let i = 0; i < PATIENTS.length; i++) {
      const [firstName, lastName, dob, phone, diagnosis, meds] = PATIENTS[i];
      await prisma.patient.create({
        data: {
          firstName,
          lastName,
          dob: new Date(dob),
          phone,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
          address: `${100 + i} Synthetic Ave, Testville, TX`,
          ssnEnc: encryptField(`900-55-${String(1000 + i).slice(1)}`),
          diagnosisEnc: encryptField(diagnosis),
          medicationHistoryEnc: encryptField(meds),
        },
      });
    }
  }

  console.log('Seeded. Demo logins:');
  USERS.forEach((u) => console.log(`  ${u.role.padEnd(11)} ${u.email} / ${u.password}`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
