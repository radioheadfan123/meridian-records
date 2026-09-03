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

  // A few appointments so the scheduling view has something to show. Reasons are
  // deliberately written as scheduling notes, not diagnoses: that distinction is
  // what the front desk is allowed to see, and a seed full of clinical text would
  // quietly undermine the feature it is demonstrating.
  const apptCount = await prisma.appointment.count();
  if (apptCount === 0) {
    const patients = await prisma.patient.findMany({ orderBy: { lastName: 'asc' }, take: 6 });
    const provider = await prisma.user.findFirst({ where: { role: 'PROVIDER' } });
    const VISITS = [
      ['FOLLOW_UP', 'follow-up on last visit', 1, 30],
      ['ANNUAL_PHYSICAL', 'yearly wellness check', 2, 45],
      ['LAB_REVIEW', 'review recent lab results', 3, 20],
      ['VACCINATION', 'seasonal vaccination', 4, 15],
      ['TELEHEALTH', 'video check-in, no travel needed', 7, 20],
      ['NEW_PATIENT', 'new patient intake and paperwork', 8, 60],
    ];

    const base = new Date();
    base.setHours(9, 0, 0, 0);

    for (let i = 0; i < patients.length; i++) {
      const [visitType, reason, dayOffset, durationMinutes] = VISITS[i];
      const startsAt = new Date(base);
      startsAt.setDate(startsAt.getDate() + dayOffset);
      startsAt.setHours(9 + i, 0, 0, 0);

      await prisma.appointment.create({
        data: {
          patientId: patients[i].id,
          providerId: provider ? provider.id : null,
          visitType,
          reasonEnc: encryptField(reason),
          startsAt,
          durationMinutes,
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
